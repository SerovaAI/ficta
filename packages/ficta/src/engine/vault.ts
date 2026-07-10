import { envFlag, type RestoreIntoToolsPolicy, restoreIntoToolsPolicy } from "./env-flags.js";
import type { ProtectedValueKind } from "./plugins/types.js";
import { type SurrogateStrategy, surrogateStrategy } from "./surrogate.js";

/**
 * The vault: redact registered/detected values → surrogates on the way up, restore them on the
 * way back. Surrogates are keyed deterministic within the local proxy process (same value → same
 * token across turns; set FICTA_SURROGATE_KEY for cross-restart stability) and JSON-safe
 * (alphanumeric + underscore, so substituting them never breaks JSON).
 *
 * The vault is intentionally plugin-agnostic. Plugins/engine decide what values enter it; the
 * vault owns the security-critical mechanics: deterministic tokenization, exact replacement,
 * fail-closed leak scanning, and streaming restore.
 */

const ENV_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY;

/** Shared empty skip-set so the common restore path allocates nothing. */
const EMPTY_SKIP: ReadonlySet<string> = new Set();

export interface VaultValue {
  value: string;
  /** Category label (e.g. "person", "us-ssn") — steers typed surrogates. `ProtectedValue` supplies it. */
  name?: string;
  /** Coarse kind — fallback type for typed surrogates when the category is unmapped. */
  kind?: ProtectedValueKind;
}

export interface VaultTraceValue {
  value: string;
  surrogate?: string;
  provenance?: LayerProvenance;
}

interface RestoreMarkers {
  start: string;
  metadata?: string;
  end: string;
}

interface RestoreOptions {
  markers?: RestoreMarkers;
}

export function surrogateKeyWarning(): string | undefined {
  if (!ENV_SURROGATE_KEY) return undefined;
  if (Buffer.byteLength(ENV_SURROGATE_KEY, "utf8") < 32 || new Set(ENV_SURROGATE_KEY).size < 8) {
    return "FICTA_SURROGATE_KEY is set but looks weak; use a high-entropy secret value (>=32 random bytes)";
  }
  return undefined;
}

/**
 * A mutable surrogate store: the deterministic value↔surrogate dictionary plus the longest-first
 * value list used for redaction. One store per protection *layer* — the permanent registry
 * (registered secrets, process-lifetime) and each request's ephemeral detected-PII layer are
 * separate stores that share a single {@link SurrogateStrategy}, so the same raw value mints the
 * same surrogate in either layer (deterministic HMAC → cross-turn/cross-layer consistency).
 */
/**
 * Where a layer's values came from, used by the `detected` restore-into-tools policy: `permanent`
 * holds registry secrets (the model only ever saw placeholders for these — keep withholding into
 * tools), `detected` holds values the agent read from local content this request (restoring their
 * placeholders into a tool leaks nothing new — the model already had the raw bytes).
 */
export type LayerProvenance = "permanent" | "detected";

export class SurrogateTable {
  readonly values: string[] = []; // known values, longest first
  private readonly seen = new Set<string>();
  readonly toSur = new Map<string, string>();
  readonly toVal = new Map<string, string>();

  constructor(
    readonly surrogate: SurrogateStrategy,
    readonly provenance: LayerProvenance = "permanent",
  ) {}

  get size(): number {
    return this.values.length;
  }

  /**
   * Register additional values, e.g. from request-time detector plugins. The store is name-blind, so
   * it cannot apply registry-policy exclusions itself: that enforcement happens upstream where names
   * are still known — `loadPluginRegistry` for launch values and `ProtectionEngine.admit()` for
   * detector/caller-supplied values. Any new code path that registers named candidates must filter
   * through `admit()` first, or excluded names will silently re-enter protection.
   */
  register(values: ReadonlyArray<VaultValue>): number {
    let added = 0;
    for (const item of values) {
      const value = item.value;
      if (!value || this.seen.has(value)) continue;
      this.seen.add(value);
      this.values.push(value);
      const sur = this.surrogate.mint(value, { name: item.name, kind: item.kind });
      this.toSur.set(value, sur);
      this.toVal.set(sur, value);
      added++;
    }
    if (added > 0) this.values.sort((a, b) => b.length - a.length);
    return added;
  }
}

/**
 * Read/redact/restore mechanics over one or more {@link SurrogateTable} layers, consulted in
 * precedence order (first match wins). A permanent {@link Vault} is a view over a single table; a
 * per-request {@link ScopedVault} is a view over `[detected, permanent]`. All the security-critical
 * mechanics (exact replacement, fail-closed leak scanning, streaming restore) live here exactly
 * once, so the CLI single-vault path and the request-scoped gateway path share the same tested code.
 */
export abstract class VaultView {
  /**
   * Distinct raw values this view has restored back into responses. Populated by `restoreText` /
   * `restoreJsonText`, so it spans buffered and streaming restore alike; the proxy reads its size
   * after a response drains to log the symmetric `♻️ restored N value(s)` line. A scope restores only
   * on its one response, so for a request scope this equals that response's restore count.
   */
  readonly restored = new Set<string>();

  protected constructor(private readonly layers: readonly [SurrogateTable, ...SurrogateTable[]]) {}

  /** How many distinct values this view has restored into responses so far. */
  get restoredCount(): number {
    return this.restored.size;
  }

  /**
   * Distinct known values ficta *declined* to restore because they appeared inside a tool-call
   * argument fragment (restore-into-tools withholding — see {@link createSseRestoreStream}). A
   * placeholder surrogate is emitted to the tool sink instead of the real secret. Read
   * symmetrically to {@link restoredCount} so the proxy can log what was held back.
   */
  readonly withheldFromTools = new Set<string>();

  /** How many distinct values were withheld from tool-call arguments in this view's responses. */
  get withheldFromToolsCount(): number {
    return this.withheldFromTools.size;
  }

  /** Shared across all layers (a single injected strategy), so any layer's is the strategy. */
  protected get surrogate(): SurrogateStrategy {
    return this.layers[0].surrogate;
  }

  /** Any layer holds a value to redact. */
  private get hasValues(): boolean {
    return this.layers.some((layer) => layer.size > 0);
  }

  /** Any layer holds a surrogate to restore. */
  private get hasSurrogates(): boolean {
    return this.layers.some((layer) => layer.toVal.size > 0);
  }

  /** Known raw values across all layers, longest first (a longer value redacts before a substring). */
  private orderedValues(): readonly string[] {
    if (this.layers.length === 1) return this.layers[0].values; // already sorted, no merge needed
    const seen = new Set<string>();
    const out: string[] = [];
    for (const layer of this.layers) {
      for (const value of layer.values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  private surrogateFor(value: string): string | undefined {
    for (const layer of this.layers) {
      const sur = layer.toSur.get(value);
      if (sur !== undefined) return sur;
    }
    return undefined;
  }

  private valueFor(surrogate: string): string | undefined {
    for (const layer of this.layers) {
      const value = layer.toVal.get(surrogate);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** Provenance of the layer that maps `surrogate` (first match wins, mirroring {@link valueFor}). */
  private provenanceFor(surrogate: string): LayerProvenance | undefined {
    for (const layer of this.layers) {
      if (layer.toVal.has(surrogate)) return layer.provenance;
    }
    return undefined;
  }

  /**
   * Surrogate and its layer's provenance for a raw value, in one pass over the layers (first match
   * wins, mirroring redaction order). traceValues needs both; the same layer that holds the surrogate
   * is the one whose provenance applies, so a single walk replaces two full layer scans.
   */
  private surrogateEntryFor(value: string): { surrogate: string; provenance: LayerProvenance } | undefined {
    for (const layer of this.layers) {
      const surrogate = layer.toSur.get(value);
      if (surrogate !== undefined) return { surrogate, provenance: layer.provenance };
    }
    return undefined;
  }

  /** Raw value → surrogate/provenance mapping for trace-only audit sidecars. */
  traceValues(values: Iterable<string>): VaultTraceValue[] {
    const out: VaultTraceValue[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const entry: VaultTraceValue = { value };
      const found = this.surrogateEntryFor(value);
      if (found) {
        entry.surrogate = found.surrogate;
        entry.provenance = found.provenance;
      }
      out.push(entry);
    }
    return out;
  }

  /** Redact known values in a raw string. */
  redactText(text: string, preservePaths = true): { text: string; count: number } {
    const result = this.redactTextDetailed(text, preservePaths);
    return { text: result.text, count: result.count };
  }

  /**
   * Redact known values in a raw string and report which raw values matched. `preservePaths` keeps a
   * value embedded in a filesystem-path-like token untouched (the default, used for the query
   * surface); the engine passes false for headers/body so a secret inside a slash-path is redacted.
   */
  redactTextDetailed(text: string, preservePaths = true): { text: string; count: number; values: string[] } {
    if (!this.hasValues || !text) return { text, count: 0, values: [] };
    const found = new Set<string>();
    return { text: this.replaceKnown(text, found, preservePaths), count: found.size, values: [...found] };
  }

  /**
   * Redact a request body. Parses JSON and replaces inside string leaves and object keys so
   * escaping stays correct; falls back to raw string replace for non-JSON. Returns the new body +
   * how many distinct known values were swapped out.
   */
  redactBody(body: string, preservePaths = true): { body: string; count: number } {
    const result = this.redactBodyDetailed(body, preservePaths);
    return { body: result.body, count: result.count };
  }

  /** Redact a request body and report which raw values matched. See {@link redactTextDetailed} for `preservePaths`. */
  redactBodyDetailed(body: string, preservePaths = true): { body: string; count: number; values: string[] } {
    if (!this.hasValues || !body) return { body, count: 0, values: [] };
    const found = new Set<string>();
    const replace = (s: string): string => this.replaceKnown(s, found, preservePaths);
    try {
      const mapped = mapStrings(JSON.parse(body), replace);
      return { body: found.size > 0 ? JSON.stringify(mapped) : body, count: found.size, values: [...found] };
    } catch {
      return { body: replace(body), count: found.size, values: [...found] };
    }
  }

  private replaceKnown(text: string, found: Set<string>, preservePaths = true): string {
    let out = text;
    for (const v of this.orderedValues()) {
      if (!knownValueMayAppear(out, v)) continue;
      const surrogate = this.surrogateFor(v);
      if (surrogate === undefined) continue;
      const replaced = replaceKnownOutsidePaths(
        out,
        v,
        surrogate,
        surrogateSpans(out, this.surrogate.pattern),
        preservePaths,
      );
      if (replaced.count === 0) continue;
      found.add(v);
      out = replaced.text;
    }
    return out;
  }

  /** Restore surrogates → real values in a chunk of text. */
  restoreText(text: string, opts: RestoreOptions = {}): string {
    return this.restoreTextExcept(text, EMPTY_SKIP, opts);
  }

  /**
   * Restore surrogates → real values, but leave any token in `skip` untouched. The SSE restore's
   * per-event deep sweep uses this so a surrogate deliberately withheld from a tool-call argument is
   * not silently re-restored when the whole event object is mapped. See {@link createSseRestoreStream}.
   */
  private restoreTextExcept(text: string, skip: ReadonlySet<string>, opts: RestoreOptions = {}): string {
    if (!this.hasSurrogates || !text) return text;
    const markerSpans = completeRestoreMarkerSpans(text, opts.markers);
    return text.replace(this.surrogate.pattern, (m, index: number) => {
      if (overlapsSpan(markerSpans, index, index + m.length)) return m;
      if (skip.has(m)) return m;
      const value = this.valueFor(m);
      if (value === undefined) return m;
      this.restored.add(value);
      return markRestoredValue(value, m, opts.markers);
    });
  }

  /**
   * Restore surrogates inside a (reassembled) tool-call argument fragment under `policy`. `all`
   * restores every mapped token; `none` restores none; `detected` restores detected-layer tokens
   * (content the agent already read locally) and keeps permanent-registry tokens as placeholders.
   * Every token left as a placeholder is added to `withheldSink` — the per-event deep sweep skips
   * those so it cannot re-restore them — and recorded in {@link withheldFromTools} for accounting.
   * Only complete tokens are acted on; a surrogate split across fragments is stitched back together
   * by the caller's `pending` reassembly before it reaches here, so split tokens are counted and
   * withheld/restored as a unit rather than silently passing through raw.
   */
  private restoreToolArgText(text: string, policy: RestoreIntoToolsPolicy, withheldSink: Set<string>): string {
    if (!this.hasSurrogates || !text) return text;
    return text.replace(this.surrogate.pattern, (m) => {
      const value = this.valueFor(m);
      if (value === undefined) return m; // unmapped placeholder — pass through untouched
      const restoreHere = policy === "all" || (policy === "detected" && this.provenanceFor(m) === "detected");
      if (restoreHere) {
        this.restored.add(value);
        return value;
      }
      withheldSink.add(m);
      this.withheldFromTools.add(value);
      return m;
    });
  }

  /**
   * Restore a JSON response body. Surrogates only ever sit inside JSON string literals/keys (they
   * are substituted into strings on the way up), so they are swapped back in place with the restored
   * value escaped for its string context. That keeps the document valid even when a restored value
   * contains `"`, `\`, or a newline (a quoted password, a multi-line PEM key) — a raw `restoreText`
   * would break the literal — while leaving every other byte untouched. A JSON.parse/JSON.stringify
   * round-trip would instead silently round integers > 2^53 and reformat numbers. Falls back to raw
   * text restore for bodies that are not valid JSON.
   *
   * When a wire's {@link BufferedRestoreAdapter} is supplied, tool-call argument regions are subject
   * to the same restore-into-tools withholding as the streaming path under FICTA_RESTORE_INTO_TOOLS:
   * `none` keeps every surrogate a placeholder, `detected` (default) restores content-derived
   * detections but withholds registry secrets, and `all` restores everything. Without an adapter
   * (unknown wire) the blanket restore is kept — there is no shape knowledge to classify tool arguments.
   */
  restoreJson(
    body: string,
    adapter: BufferedRestoreAdapter = NOOP_BUFFERED_RESTORE_ADAPTER,
    opts: RestoreOptions = {},
  ): string {
    if (!this.hasSurrogates || !body) return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.restoreText(body, opts);
    }
    return this.restoreJsonText(body, this.collectWithheldToolTokens(adapter, parsed, this.toolPolicy()), opts);
  }

  /** The active restore-into-tools policy (read per call, mirroring the streaming path). */
  private toolPolicy(): RestoreIntoToolsPolicy {
    return restoreIntoToolsPolicy(process.env.FICTA_RESTORE_INTO_TOOLS);
  }

  /**
   * Surrogate tokens inside the tool-call argument regions of a parsed payload that the
   * restore-into-tools `policy` keeps as placeholders — the buffered/replay analogue of
   * {@link restoreToolArgText}. `all` withholds nothing (empty set → blanket restore); `none`
   * withholds every mapped token; `detected` withholds only permanent-registry tokens, letting
   * detected-layer tokens restore. Each withheld token is recorded in {@link withheldFromTools} so
   * the count spans buffered and streaming restore alike.
   */
  private collectWithheldToolTokens(
    adapter: BufferedRestoreAdapter,
    parsed: unknown,
    policy: RestoreIntoToolsPolicy,
  ): ReadonlySet<string> {
    if (policy === "all") return EMPTY_SKIP;
    let withheld: Set<string> | undefined;
    for (const region of adapter.toolArgumentTexts(parsed)) {
      for (const token of region.match(this.surrogate.pattern) ?? []) {
        if (policy === "detected" && this.provenanceFor(token) === "detected") continue; // will be restored
        const value = this.valueFor(token);
        if (value === undefined) continue;
        withheld ??= new Set();
        withheld.add(token);
        this.withheldFromTools.add(value);
      }
    }
    return withheld ?? EMPTY_SKIP;
  }

  /**
   * In-place surrogate restore for JSON text, escaping each value for its string context. Tokens in
   * `skip` are left untouched — the buffered withhold path passes the tool-argument tokens here so
   * the body-wide restore cannot undo the withholding (mirror of {@link restoreTextExcept}).
   */
  restoreJsonText(text: string, skip: ReadonlySet<string> = EMPTY_SKIP, opts: RestoreOptions = {}): string {
    if (!this.hasSurrogates || !text) return text;
    const markerSpans = completeRestoreMarkerSpans(text, opts.markers, { includeJsonEscaped: true });
    return text.replace(this.surrogate.pattern, (m, index: number) => {
      if (overlapsSpan(markerSpans, index, index + m.length)) return m;
      if (skip.has(m)) return m;
      const value = this.valueFor(m);
      if (value === undefined) return m;
      this.restored.add(value);
      return jsonStringEscape(markRestoredValue(value, m, opts.markers));
    });
  }

  /**
   * Fail-closed gate: how many registered/detected values are still present in an
   * already-redacted outbound body/text. Must be 0 before we forward. JSON redaction
   * intentionally only mutates strings/keys so primitive numbers keep their type; the raw
   * body backstop catches numeric-looking values that survived that semantic pass.
   */
  leakCount(body: string, preservePaths = true): number {
    return this.leakValues(body, preservePaths).length;
  }

  /**
   * Raw registered/detected values that still survive in already-redacted outbound text/body.
   * `preservePaths` must match the redaction pass for this surface so the fail-closed gate stays
   * consistent with it — a path-embedded value the engine chose to redact (header/body) is also
   * scanned for here, while the query surface keeps its path-preservation.
   */
  leakValues(body: string, preservePaths = true): string[] {
    if (!this.hasValues || !body) return [];
    const strings: string[] = [];
    let masked: string | undefined;
    try {
      collectStrings(JSON.parse(body), strings);
      masked = maskJsonStringLiterals(body);
    } catch {
      // Non-JSON: the whole raw body is scanned for any known value below.
    }
    // A minted token is opaque HMAC output, so a value "found" inside one is not a leak — most
    // notably a detected value like "FICTA" (the model narrating tokens) matches every token's
    // prefix, including its own replacement, and would otherwise block every follow-up turn.
    const stringSpans = strings.map((s) => surrogateSpans(s, this.surrogate.pattern));
    const bodySpans = masked === undefined ? surrogateSpans(body, this.surrogate.pattern) : [];
    const leaked: string[] = [];
    for (const v of this.orderedValues()) {
      const stringLeak = strings.some((s, i) => containsKnownOutsidePaths(s, v, stringSpans[i], preservePaths));
      // For valid JSON, string contents are masked out, so the backstop scans only primitives and
      // matches a value as a complete token — never as a substring of a longer number (so a
      // registered `12345678` is not flagged inside an unrelated `99912345678`).
      const primitiveLeak =
        masked === undefined
          ? containsKnownOutsidePaths(body, v, bodySpans, preservePaths)
          : containsKnownPrimitive(masked, v);
      if (stringLeak || primitiveLeak) leaked.push(v);
    }
    return leaked;
  }

  /** True when text contains any known raw value, using the same matcher as redaction/leak gates. */
  containsKnownValue(text: string, preservePaths = true): boolean {
    if (!this.hasValues || !text) return false;
    const spans = surrogateSpans(text, this.surrogate.pattern);
    return this.orderedValues().some((value) => containsKnownOutsidePaths(text, value, spans, preservePaths));
  }

  /**
   * Distinct minted surrogate tokens present in `text` that this view can map back to a value — i.e. the
   * exact allow-list the model may reference. Filtered by {@link valueFor} so a stray FICTA_-shaped token
   * that isn't a real surrogate is never advertised as one. Used to build the preserve-literals prompt.
   */
  surrogatesIn(text: string): string[] {
    if (!this.hasSurrogates || !text) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const re = new RegExp(this.surrogate.pattern.source, "g");
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const token = m[0];
      if (seen.has(token)) continue;
      seen.add(token);
      if (this.valueFor(token) !== undefined) out.push(token);
    }
    return out;
  }

  /**
   * A TransformStream that restores surrogates in a streamed response. Holds back a short tail
   * each chunk so a surrogate split across chunk boundaries is never emitted half-restored.
   */
  restoreStream(opts: RestoreOptions = {}): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const HOLD = this.surrogate.maxLength - 1; // max partial surrogate; a full token is maxLength chars
    let buf = "";
    const self = this;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Restore complete surrogates in the full buffer; only a partial token can remain at the tail.
        buf = self.restoreText(buf + decoder.decode(chunk, { stream: true }), opts);
        if (buf.length > HOLD) {
          controller.enqueue(encoder.encode(buf.slice(0, buf.length - HOLD)));
          buf = buf.slice(buf.length - HOLD);
        }
      },
      flush(controller) {
        buf = self.restoreText(buf + decoder.decode(), opts);
        if (buf) controller.enqueue(encoder.encode(buf));
      },
    });
  }

  /**
   * SSE restore for provider streams that carry text/tool-call arguments as JSON string fragments.
   * A surrogate can be split across adjacent SSE events even when the raw bytes are not adjacent;
   * the provider-specific `adapter` (see wire-restore.ts) names which semantic fragments to buffer
   * until they can be restored. The vault owns only the generic, provider-agnostic SSE mechanics.
   */
  restoreEventStream(
    adapter: SseRestoreAdapter,
    buffered: BufferedRestoreAdapter = NOOP_BUFFERED_RESTORE_ADAPTER,
    opts: RestoreOptions = {},
  ): TransformStream<Uint8Array, Uint8Array> {
    // Restore-into-tools policy (default `detected`): surrogates the model placed inside a tool-call
    // argument are handled by provenance. A registry secret restored there would hand the real value
    // to whatever the agent executes (a `curl`, a file write) — and the model only ever saw its
    // placeholder — so those stay withheld; a detected-layer value (content the agent already read
    // locally) restores, since withholding it only corrupts files without denying the model anything
    // it lacked. `all` restores everything, `none` withholds everything. The `buffered` adapter
    // extends the same policy to full-payload replay events (deltas already withheld must not be
    // restored when the provider re-sends the completed tool call).
    const policy = restoreIntoToolsPolicy(process.env.FICTA_RESTORE_INTO_TOOLS);
    // Highlight markers (the trace-demo UI hint that drives the gateway's show/hide toggle) belong on
    // human-facing assistant output — the `kind: "text"` streamed fragments the UI renders and their
    // sibling fields (e.g. `reasoning_content`) in the SAME event. They must NOT land on events that
    // merely echo the request back: `response.created` / `response.in_progress` carry the request
    // `instructions` (surrogates the model never generated), and highlighting those decorates a field
    // the UI never surfaces. The split is by path in restoreSseRecord: the fragment path restores with
    // markers (`displayText` + the marker-aware `restoreExcept`), the no-fragment metadata/replay path
    // restores plainly (`plainText` + `restoreJsonExcept`). `[DONE]` and flushed tails use `plainText`.
    const plainText = (text: string) => this.restoreText(text);
    const displayText = opts.markers ? (text: string) => this.restoreText(text, opts) : plainText;
    return createSseRestoreStream(
      plainText,
      adapter,
      this.surrogate,
      {
        withhold: policy !== "all",
        // Fragment-path deep sweep over sibling fields: marker-aware so it decorates a genuinely
        // restored sibling and skips surrogates already wrapped by the fragment loop's markers.
        restoreExcept: (text, skip) => this.restoreTextExcept(text, skip, opts),
        // No-fragment metadata/replay path (the request-echo events): plain, so `instructions` and
        // other non-output fields are restored without highlight decoration.
        restoreJsonExcept: (text, skip) => this.restoreJsonText(text, skip),
        collectWithheld: (data) => this.collectWithheldToolTokens(buffered, data, policy),
        restoreToolArg: (text, withheldSink) => this.restoreToolArgText(text, policy, withheldSink),
      },
      displayText,
    );
  }
}

/**
 * The permanent vault: registered/launch-time values (registered secrets), loaded once and shared
 * across every request. Behaviour is identical to the pre-scope single vault — this is what keeps
 * the CLI paradigm (protect codex/pi/claude from leaking registered secrets) working unchanged.
 * Request-time detected PII must NOT be registered here; open a {@link ScopedVault} via
 * {@link beginScope} so detected values live and die with a single request.
 */
export class Vault extends VaultView {
  private readonly permanent: SurrogateTable;

  constructor(values: ReadonlyArray<VaultValue> = [], surrogate: SurrogateStrategy = surrogateStrategy()) {
    const permanent = new SurrogateTable(surrogate, "permanent");
    permanent.register(values);
    super([permanent]);
    this.permanent = permanent;
  }

  get size(): number {
    return this.permanent.size;
  }

  /** Register additional permanent values (launch-time registry ingress only). See {@link SurrogateTable.register}. */
  register(values: ReadonlyArray<VaultValue>): number {
    return this.permanent.register(values);
  }

  /**
   * Open a per-request scope: an ephemeral detected-PII layer stacked over this permanent vault,
   * sharing its {@link SurrogateStrategy}. Detected values register into the scope only and are
   * discarded when the scope is dropped, so they neither grow the permanent vault nor leak across
   * requests. Restore/leak/redact in the scope consult detected-then-permanent.
   *
   * Pass `detected` and `registryDerived` to stack existing persistent (e.g. per-thread) layers
   * instead of fresh ones: the view itself stays per-request (its `restored` accounting is fresh)
   * while both value↔surrogate dictionaries are shared across the scope key's requests.
   */
  beginScope(detected?: SurrogateTable, registryDerived?: SurrogateTable): ScopedVault {
    return new ScopedVault(this.permanent, detected, registryDerived);
  }

  /** A detached detected-PII layer sharing this vault's strategy, for persistent keyed scopes. */
  newDetectedLayer(): SurrogateTable {
    return new SurrogateTable(this.permanent.surrogate, "detected");
  }

  /** A detached registry-derived layer for persistent keyed scopes, with permanent provenance. */
  newRegistryDerivedLayer(): SurrogateTable {
    return new SurrogateTable(this.permanent.surrogate, "permanent");
  }
}

/**
 * A request-scoped vault: an ephemeral detected-value layer over the shared permanent vault. Created
 * per request via {@link Vault.beginScope}; detection registers into the detected layer, and the
 * whole scope (with its detected surrogates) is garbage-collected when the request handler returns.
 * This bounds memory and — because the detected `toVal` is private to the scope — prevents one
 * request's PII from being restored into another request's response.
 */
export class ScopedVault extends VaultView {
  private readonly detected: SurrogateTable;
  private readonly registryDerived: SurrogateTable;

  constructor(
    permanent: SurrogateTable,
    detected: SurrogateTable = new SurrogateTable(permanent.surrogate, "detected"),
    registryDerived: SurrogateTable = new SurrogateTable(permanent.surrogate, "permanent"),
  ) {
    // Registry-derived variants (e.g. the caps twin of a registered secret found in a request body)
    // live in a separate layer because they ARE the registry secret in another casing. The layer is
    // request-owned by default and may be shared by a keyed scope; either way its `permanent`
    // provenance makes the `detected` restore-into-tools policy withhold variants exactly like the
    // canonical form. Ordered before `detected` so registry authority wins a duplicate (first match).
    super([registryDerived, detected, permanent]); // all share the permanent strategy → same surrogates
    this.detected = detected;
    this.registryDerived = registryDerived;
  }

  /** Register request-detected values into the ephemeral layer only (never the permanent vault). */
  register(values: ReadonlyArray<VaultValue>): number {
    return this.detected.register(values);
  }

  /**
   * Register request-found variants OF registered values (case twins — see the engine's
   * `registerRegistryCaseVariants`). The layer is ephemeral for ordinary requests and persistent for
   * keyed scopes, always with `permanent` provenance so tool-withholding and reporting treat the
   * variant as the registry secret it is.
   */
  registerRegistryDerived(values: ReadonlyArray<VaultValue>): number {
    return this.registryDerived.register(values);
  }

  /** Count of ephemeral values detected in this request (the permanent layer is excluded). */
  get detectedSize(): number {
    return this.detected.size;
  }
}

interface SseField {
  raw: string;
  name?: string;
  value?: string;
}

interface SseRecord {
  fields: SseField[];
  data?: string;
  eventName?: string;
}

interface PendingSseFragment {
  value: string;
  eventName?: string;
  flushData: (value: string) => Record<string, unknown>;
}

export interface StreamingTextFragment extends PendingSseFragment {
  /**
   * Whether this fragment carries human-facing assistant text (`"text"`) or the arguments of a
   * tool/function call (`"tool"`). Tool fragments are the exfil-sensitive channel: a restored
   * surrogate here is executed by the agent. The wire adapters classify each fragment; the restore
   * loop uses it to decide whether to withhold restoration. See {@link ToolRestorePolicy}.
   */
  kind: "text" | "tool";
  key: string;
  setValue: (value: string) => void;
}

/**
 * Provider-specific knowledge the generic SSE restore needs: which fields in a parsed event are
 * incremental text fragments to accumulate/restore, and which events signal a logical end (so any
 * held partial surrogate can be flushed). Implemented per wire in wire-restore.ts.
 */
export interface SseRestoreAdapter {
  fragments(data: unknown, eventName?: string): StreamingTextFragment[];
  stopPrefixes(data: unknown): string[];
}

/**
 * Provider-specific knowledge for complete (non-delta) payloads: the raw text regions that carry
 * tool-call arguments, so restore-into-tools withholding covers the buffered response path and
 * full-payload SSE replay events (e.g. openai-responses `response.completed`) — not just streamed
 * deltas. Regions are scanned for surrogate tokens, never rewritten. Implemented per wire in
 * wire-restore.ts.
 */
export interface BufferedRestoreAdapter {
  toolArgumentTexts(body: unknown): string[];
}

/** No shape knowledge: nothing is classified as a tool argument, so the blanket restore is kept. */
export const NOOP_BUFFERED_RESTORE_ADAPTER: BufferedRestoreAdapter = { toolArgumentTexts: () => [] };

/**
 * Restore-into-tools policy for the SSE restore. When `withhold` is true, surrogates that appear in
 * a tool-call argument fragment are resolved by `restoreToolArg`, which restores the tokens the
 * policy permits (all, or detected-layer only) and leaves the rest as placeholders so a placeholder
 * reaches the executed tool, never the real secret. Crucially the tool path takes the SAME
 * cross-fragment reassembly as text: `restoreToolArg` runs on the reassembled `pending`+fragment
 * text, so a surrogate split across several `input_json_delta` chunks is stitched back to a whole
 * token before the per-token decision — the split-token bug that let placeholder pieces pass through
 * verbatim (and never counted) onto disk. Each token it withholds is added to `withheldSink` so the
 * per-event deep sweep (`restoreExcept`) cannot re-restore it, and counted for the Gateway view.
 */
interface ToolRestorePolicy {
  withhold: boolean;
  restoreExcept: (text: string, skip: ReadonlySet<string>) => string;
  /** JSON-context restore that leaves `skip` tokens in place (see {@link VaultView.restoreJsonText}). */
  restoreJsonExcept: (text: string, skip: ReadonlySet<string>) => string;
  /** Tool-argument tokens in a complete event payload (replay events), already counted as withheld. */
  collectWithheld: (data: unknown) => ReadonlySet<string>;
  /** Restore a reassembled tool-argument fragment per policy; withheld tokens go to `withheldSink`. */
  restoreToolArg: (text: string, withheldSink: Set<string>) => string;
}

function createSseRestoreStream(
  restoreText: (text: string) => string,
  adapter: SseRestoreAdapter,
  surrogate: SurrogateStrategy,
  tool: ToolRestorePolicy,
  /** Restore used for human-facing `kind: "text"` fragments only. Defaults to the plain `restoreText`;
   *  the highlight-marker variant is threaded here so decoration never lands on non-text fields. */
  restoreDisplayText: (text: string) => string = restoreText,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = new Map<string, PendingSseFragment>();
  let buf = "";

  const encode = (text: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (text) controller.enqueue(encoder.encode(text));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = findSseRecordBoundary(buf);
        if (!boundary) break;
        const record = buf.slice(0, boundary.index + boundary.length);
        buf = buf.slice(boundary.index + boundary.length);
        encode(
          restoreSseRecord(record, pending, restoreText, adapter, surrogate, tool, restoreDisplayText),
          controller,
        );
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf) {
        encode(restoreSseRecord(buf, pending, restoreText, adapter, surrogate, tool, restoreDisplayText), controller);
      }
      encode(flushPendingSseFragments(pending, restoreText), controller);
    },
  });
}

function restoreSseRecord(
  record: string,
  pending: Map<string, PendingSseFragment>,
  restoreText: (text: string) => string,
  adapter: SseRestoreAdapter,
  surrogate: SurrogateStrategy,
  tool: ToolRestorePolicy,
  restoreDisplayText: (text: string) => string,
): string {
  const parsed = parseSseRecord(record);
  if (parsed.data?.trim() === "[DONE]") {
    return flushPendingSseFragments(pending, restoreText) + restoreText(record);
  }

  let data: unknown;
  if (parsed.data !== undefined) {
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return restoreText(record);
    }
  }

  let prefix = "";
  for (const stopPrefix of adapter.stopPrefixes(data)) {
    prefix += flushPendingSseFragments(pending, restoreText, stopPrefix);
  }

  const fragments = adapter.fragments(data, parsed.eventName);
  if (fragments.length === 0) {
    // No incremental fragments to reassemble. If the event body parsed as JSON, restore surrogates
    // inside its `data:` payload in place (escaping each restored value for its string context) so
    // numbers and formatting survive untouched; otherwise fall back to a raw text restore. Replay
    // events (e.g. openai-responses `response.completed` / `output_item.done`) re-send COMPLETE
    // tool-call arguments here, so the same withhold policy that held back every delta must hold
    // back the replay too — otherwise the final event would hand the sink the real secret anyway.
    if (data === undefined) return prefix + restoreText(record);
    const withheld = tool.withhold ? tool.collectWithheld(data) : EMPTY_SKIP;
    return prefix + renderSseRecordRawData(parsed, tool.restoreJsonExcept(parsed.data ?? "", withheld));
  }

  // Tokens withheld from tool-call arguments in this event; the deep sweep below must not restore
  // them either (a single delta can carry a whole surrogate, not just a split fragment).
  const withheld = tool.withhold ? new Set<string>() : undefined;
  for (const fragment of fragments) {
    // Tool fragments take the SAME pending-reassembly as text: a surrogate split across several
    // `input_json_delta` chunks is stitched back to a whole token here, then `restoreToolArg`
    // makes the per-token restore/withhold decision on the complete token. Under withhold this is
    // the fix for split-token pass-through — a partial fragment can no longer slip a placeholder
    // piece through unrestored and uncounted. Text fragments (and, under `all`, tool fragments)
    // use the blanket restore.
    const restore =
      withheld && fragment.kind === "tool"
        ? (text: string) => tool.restoreToolArg(text, withheld)
        : fragment.kind === "text"
          ? restoreDisplayText
          : restoreText;
    const combined = (pending.get(fragment.key)?.value ?? "") + fragment.value;
    const restored = restore(combined);
    const { emit, hold } = splitForPotentialSurrogate(restored, surrogate);
    if (hold) pending.set(fragment.key, { value: hold, eventName: fragment.eventName, flushData: fragment.flushData });
    else pending.delete(fragment.key);
    fragment.setValue(emit);
  }

  // Fragment fields now hold restored text (any partial-surrogate tail lives in `pending`), so a
  // deep restore over the parsed record only touches sibling fields the adapter does not name
  // (e.g. an OpenAI delta's reasoning_content/refusal). Those siblings are still assistant output, so
  // this fragment-path sweep restores WITH markers (`restoreExcept`/`displayText` are marker-aware:
  // they decorate a genuinely restored sibling and skip surrogates already wrapped by the fragment
  // loop above). JSON serialization re-escapes them. Tool fragments left a placeholder in place; the
  // deep sweep skips those withheld tokens so it cannot undo the withholding.
  const deepRestore =
    withheld && withheld.size > 0 ? (text: string) => tool.restoreExcept(text, withheld) : restoreDisplayText;
  return prefix + renderSseJsonRecord(parsed, mapStrings(data, deepRestore));
}

function flushPendingSseFragments(
  pending: Map<string, PendingSseFragment>,
  restoreText: (text: string) => string,
  keyPrefix = "",
): string {
  let out = "";
  for (const [key, fragment] of [...pending]) {
    if (keyPrefix && !key.startsWith(keyPrefix)) continue;
    const value = restoreText(fragment.value);
    if (value) out += renderSseDataEvent(fragment.eventName, fragment.flushData(value));
    pending.delete(key);
  }
  return out;
}

function splitForPotentialSurrogate(text: string, surrogate: SurrogateStrategy): { emit: string; hold: string } {
  const max = Math.min(surrogate.maxLength - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (surrogate.isPotentialPrefix(suffix)) {
      return { emit: text.slice(0, text.length - length), hold: suffix };
    }
  }
  return { emit: text, hold: "" };
}

function findSseRecordBoundary(text: string): { index: number; length: number } | undefined {
  const candidates = [
    { index: text.indexOf("\r\n\r\n"), length: 4 },
    { index: text.indexOf("\n\n"), length: 2 },
    { index: text.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index !== -1);
  return candidates.sort((a, b) => a.index - b.index)[0];
}

function parseSseRecord(record: string): SseRecord {
  const body = record.replace(/(?:\r\n\r\n|\n\n|\r\r)$/, "");
  const lines = body ? body.split(/\r\n|\n|\r/) : [];
  const fields = lines.map(parseSseField);
  const data = fields
    .filter((field) => field.name === "data")
    .map((field) => field.value ?? "")
    .join("\n");
  let eventName: string | undefined;
  for (const field of fields) if (field.name === "event") eventName = field.value;
  return { fields, data: data || undefined, eventName };
}

function parseSseField(line: string): SseField {
  if (line.startsWith(":")) return { raw: line };
  const colon = line.indexOf(":");
  if (colon === -1) return { raw: line, name: line, value: "" };
  const name = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  return { raw: line, name, value };
}

function renderSseJsonRecord(record: SseRecord, data: unknown): string {
  return renderSseRecordRawData(record, JSON.stringify(data));
}

/** Re-render an SSE record, replacing its `data:` field(s) with already-serialized JSON text. */
function renderSseRecordRawData(record: SseRecord, dataText: string): string {
  const lines = record.fields.filter((field) => field.name !== "data").map((field) => field.raw);
  lines.push(`data: ${dataText}`);
  return `${lines.join("\n")}\n\n`;
}

function renderSseDataEvent(eventName: string | undefined, data: unknown): string {
  const lines = eventName ? [`event: ${eventName}`] : [];
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Spans of already-minted surrogate tokens in `text`. A value occurrence overlapping one must be
 * left alone on both sides of the fail-closed gate: rewriting inside a token corrupts it (breaking
 * restore of the token it belongs to), and matching inside one is a false leak — the token is
 * opaque HMAC output whose characters say nothing about the value's presence. The canonical
 * offender is a detected value that is itself a token substring (e.g. Presidio tagging the word
 * "FICTA" in a transcript where the model discussed its own tokens): replacing it re-introduces
 * the value inside its own surrogate, which un-guarded leak scanning then flags on every turn.
 */
function surrogateSpans(text: string, pattern: RegExp): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const re = new RegExp(pattern.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) spans.push([m.index, m.index + m[0].length]);
  return spans.length === 0 ? NO_SPANS : spans;
}

const NO_SPANS: ReadonlyArray<readonly [number, number]> = [];

/** Whether [start, end) overlaps any of the (ordered) excluded spans. */
function overlapsSpan(spans: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
  for (const [s, e] of spans) {
    if (s >= end) return false; // spans are in text order; nothing further can overlap
    if (e > start) return true;
  }
  return false;
}

function replaceKnownOutsidePaths(
  text: string,
  needle: string,
  replacement: string,
  excludedSpans: ReadonlyArray<readonly [number, number]> = NO_SPANS,
  preservePaths = true,
): { text: string; count: number } {
  if (!needle) return { text, count: 0 };

  let out = "";
  let cursor = 0;
  let count = 0;
  const matches = knownValueMatches(text, needle);

  for (const { index, end } of matches) {
    if (overlapsSpan(excludedSpans, index, end) || isInsidePathLikeToken(text, index, end, needle, preservePaths)) {
      out += text.slice(cursor, end);
    } else {
      out += text.slice(cursor, index) + replacement;
      count++;
    }
    cursor = end;
  }

  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(cursor), count };
}

/**
 * Backstop leak check for a registered value that survives the string-only redaction pass as a bare
 * JSON primitive (e.g. a number). `maskJsonStringLiterals` has already blanked every string's
 * contents, so only primitives + structure remain; match `needle` as a complete token, never as a
 * substring of a longer number (a registered `12345678` must not register inside `99912345678`).
 */
function containsKnownPrimitive(masked: string, needle: string): boolean {
  if (!needle) return false;
  let cursor = 0;
  for (;;) {
    const index = masked.indexOf(needle, cursor);
    if (index === -1) return false;
    if (!isTokenContinuation(masked[index - 1]) && !isTokenContinuation(masked[index + needle.length])) return true;
    cursor = index + 1;
  }
}

function isTokenContinuation(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.+-]/.test(ch);
}

function jsonStringEscape(value: string): string {
  // JSON.stringify yields a fully-escaped, quoted string literal; drop the surrounding quotes to get
  // content safe to substitute inside an existing JSON string.
  const json = JSON.stringify(value);
  return json.slice(1, -1);
}

function markRestoredValue(value: string, surrogate: string, markers: RestoreMarkers | undefined): string {
  if (!markers) return value;
  return markers.metadata
    ? `${markers.start}${surrogate}${markers.metadata}${value}${markers.end}`
    : `${markers.start}${value}${markers.end}`;
}

function completeRestoreMarkerSpans(
  text: string,
  markers: RestoreMarkers | undefined,
  opts: { includeJsonEscaped?: boolean } = {},
): ReadonlyArray<readonly [number, number]> {
  if (!markers || !text) return NO_SPANS;
  const spans = markerSpansForDelimiters(text, markers.start, markers.end);
  if (!opts.includeJsonEscaped) return spans.length === 0 ? NO_SPANS : spans;

  const escapedStart = jsonStringEscape(markers.start);
  const escapedEnd = jsonStringEscape(markers.end);
  if (escapedStart === markers.start && escapedEnd === markers.end) return spans.length === 0 ? NO_SPANS : spans;

  const escapedSpans = markerSpansForDelimiters(text, escapedStart, escapedEnd);
  if (spans.length === 0) return escapedSpans.length === 0 ? NO_SPANS : escapedSpans;
  if (escapedSpans.length === 0) return spans;
  return [...spans, ...escapedSpans].sort((a, b) => a[0] - b[0]);
}

function markerSpansForDelimiters(
  text: string,
  startMarker: string,
  endMarker: string,
): Array<readonly [number, number]> {
  if (!startMarker || !endMarker) return [];
  const spans: Array<readonly [number, number]> = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(startMarker, cursor);
    if (start === -1) return spans;
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (end === -1) return spans;
    const spanEnd = end + endMarker.length;
    spans.push([start, spanEnd]);
    cursor = spanEnd;
  }
}

function containsKnownOutsidePaths(
  text: string,
  needle: string,
  excludedSpans: ReadonlyArray<readonly [number, number]> = NO_SPANS,
  preservePaths = true,
): boolean {
  if (!needle) return false;
  for (const { index, end } of knownValueMatches(text, needle)) {
    if (!overlapsSpan(excludedSpans, index, end) && !isInsidePathLikeToken(text, index, end, needle, preservePaths))
      return true;
  }
  return false;
}

function knownValueMayAppear(text: string, value: string): boolean {
  if (text.includes(value)) return true;
  return hasWhitespace(value) && flexibleWhitespacePattern(value).test(text);
}

function knownValueMatches(text: string, value: string): Array<{ index: number; end: number }> {
  if (!hasWhitespace(value)) {
    const matches: Array<{ index: number; end: number }> = [];
    let cursor = 0;
    for (;;) {
      const index = text.indexOf(value, cursor);
      if (index === -1) return matches;
      const end = index + value.length;
      matches.push({ index, end });
      cursor = end;
    }
  }

  const matches: Array<{ index: number; end: number }> = [];
  const re = flexibleWhitespacePattern(value);
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    matches.push({ index: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

// The same value's flexible pattern is compiled repeatedly in one redact pass (the knownValueMayAppear
// guard, then knownValueMatches) and on every leak scan, so cache it per value. The regexes are global
// (stateful lastIndex), so callers get it reset on lookup; a size cap bounds memory as new detected
// values accumulate over the process lifetime.
const FLEXIBLE_PATTERN_CACHE_LIMIT = 2048;
const flexiblePatternCache = new Map<string, RegExp>();

function flexibleWhitespacePattern(value: string): RegExp {
  let pattern = flexiblePatternCache.get(value);
  if (pattern === undefined) {
    pattern = buildFlexibleWhitespacePattern(value);
    if (flexiblePatternCache.size >= FLEXIBLE_PATTERN_CACHE_LIMIT) {
      const oldest = flexiblePatternCache.keys().next().value; // Map preserves insertion order
      if (oldest !== undefined) flexiblePatternCache.delete(oldest);
    }
    flexiblePatternCache.set(value, pattern);
  }
  pattern.lastIndex = 0; // shared global regex: reset state before each .test()/.exec()
  return pattern;
}

function buildFlexibleWhitespacePattern(value: string): RegExp {
  // Match a registered value across serialized whitespace differences (e.g. a document parser
  // reflowing "Proxima Medical Supplies CC" into "Proxima Medical\nSupplies CC"). Each separator
  // permits at most one line break — single-line wrap (incl. next-line indentation and \r\n) still
  // matches, but a blank line / paragraph break does not, so unrelated adjacent tokens across a
  // paragraph boundary are not collapsed into one value. A separator must still be present: this
  // must not match "ProximaMedical" for a registered "Proxima Medical".
  const source = value
    .split(/(\s+)/)
    .map((part) =>
      hasWhitespace(part) ? "(?:[^\\S\\r\\n]+|[^\\S\\r\\n]*(?:\\r\\n|\\r|\\n)[^\\S\\r\\n]*)" : escapeRegExp(part),
    )
    .join("");
  return new RegExp(source, "g");
}

/**
 * Distinct surface substrings of `text` that match `value` under the same whitespace-flexible rules the
 * vault uses for redaction (see {@link buildFlexibleWhitespacePattern}), optionally case-insensitively.
 * Returned forms are the literal text as it appears — so a caller can register each casing it finds and
 * have redaction match and round-trip it. Used by the PII plugin to cover an entity detected in one
 * casing that also appears in another (e.g. a title-case name that recurs ALL-CAPS in a heading), which
 * the case-sensitive matcher would otherwise leak.
 */
export function flexibleOccurrences(
  text: string,
  value: string,
  opts: { caseInsensitive?: boolean; wordBounded?: boolean } = {},
): string[] {
  if (!text || !value) return [];
  // Reuse the exact redaction pattern so any form returned is guaranteed to match on redaction; add `i`
  // only for the case-insensitive sweep. A fresh RegExp keeps this off the shared lastIndex-stateful cache.
  const re = new RegExp(buildFlexibleWhitespacePattern(value).source, opts.caseInsensitive ? "gi" : "g");
  const out: string[] = [];
  const seen = new Set<string>();
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const form = match[0];
    const bounded = !opts.wordBounded || hasTokenBoundaries(text, match.index, match.index + form.length, value);
    if (form && bounded && !seen.has(form)) {
      seen.add(form);
      out.push(form);
    }
    if (match.index === re.lastIndex) re.lastIndex += 1; // defensive: never spin on a zero-width match
  }
  return out;
}

/** Reject a word-like match embedded in a larger Unicode word, while leaving punctuation edges alone. */
function hasTokenBoundaries(text: string, start: number, end: number, value: string): boolean {
  const first = codePointAfter(value, 0);
  const last = codePointBefore(value, value.length);
  if (isWordCodePoint(first) && isWordCodePoint(codePointBefore(text, start))) return false;
  if (isWordCodePoint(last) && isWordCodePoint(codePointAfter(text, end))) return false;
  return true;
}

function isWordCodePoint(value: string): boolean {
  return value !== "" && /[\p{L}\p{M}\p{N}_]/u.test(value);
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  const high = index > 1 ? text.charCodeAt(index - 2) : 0;
  const paired = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  const start = paired ? index - 2 : index - 1;
  return text.slice(start, index);
}

function codePointAfter(text: string, index: number): string {
  if (index >= text.length) return "";
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInsidePathLikeToken(
  text: string,
  start: number,
  end: number,
  needle?: string,
  preservePaths = true,
): boolean {
  // preservePaths is the per-surface policy (the engine passes false for header/body so a registered
  // value embedded in a slash-path there is still redacted); redactPathsEnabled() is the global
  // FICTA_REDACT_PATHS override. Either one being off means "do not treat this as a path to skip".
  if (!preservePaths || redactPathsEnabled()) return false;

  const [tokenStart, tokenEnd] = tokenBounds(text, start, end);
  const token = text.slice(tokenStart, tokenEnd);
  const pathKind = pathLikeKind(token);
  const shellPathArg = isShellPathArgument(text, tokenStart);
  if (!pathKind && !shellPathArg) return false;

  if (needle === undefined || canPreservePathSegmentOccurrence(needle)) return true;
  if (shellPathArg) return true;
  if (pathKind === "explicit" && !isAssignmentValue(text, tokenStart)) return true;
  return false;
}

function canPreservePathSegmentOccurrence(needle: string): boolean {
  // Path preservation always applies to simple path-segment-like values (for example an AWS region
  // or profile name) embedded in paths. More complex values containing '/', '\\', quotes,
  // whitespace, or control characters are only preserved in stronger path contexts below.
  return /^[A-Za-z0-9_.:@+=-]+$/.test(needle);
}

function redactPathsEnabled(): boolean {
  return envFlag(process.env.FICTA_REDACT_PATHS);
}

function tokenBounds(text: string, start: number, end: number): [number, number] {
  let left = start;
  while (left > 0 && !isTokenBoundary(text[left - 1] ?? "")) left--;

  let right = end;
  while (right < text.length && !isTokenBoundary(text[right] ?? "")) right++;

  return [left, right];
}

function isTokenBoundary(ch: string): boolean {
  return ch === "" || /\s/.test(ch) || "=\"'`<>(){}[],;|&".includes(ch);
}

type PathLikeKind = "explicit" | "relative";

function pathLikeKind(token: string): PathLikeKind | undefined {
  const value = trimPathPunctuation(token);
  if (!value) return undefined;

  const scheme = value.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (scheme) return value.slice(scheme.index).toLowerCase().startsWith("file://") ? "explicit" : undefined;

  if (/^(?:\/|~\/|\.\/|\.\.\/)/.test(value)) return "explicit";
  if (/^[A-Za-z]:[\\/]/.test(value)) return "explicit";
  if (value.includes("/") || value.includes("\\")) return "relative";
  return undefined;
}

function isAssignmentValue(text: string, tokenStart: number): boolean {
  return tokenStart > 0 && text[tokenStart - 1] === "=";
}

function isShellPathArgument(text: string, tokenStart: number): boolean {
  const before = text.slice(0, tokenStart);
  const segment = before.slice(lastShellSeparatorIndex(before) + 1).replace(/["'`]+$/g, "");

  // Bare directory names are path-like when they are the path operand of common directory-changing
  // forms. This prevents cwd/project names such as "eu-central-1-prod" from becoming unusable
  // `cd FICTA_...` commands, while still redacting ordinary env assignments like
  // `AWS_PROFILE=eu-central-1-prod`.
  if (/(^|[\s(])(?:cd|pushd)\s+$/.test(segment)) return true;
  if (/(^|[\s(])git\s+-C\s+$/.test(segment)) return true;
  if (/(^|[\s(])make\s+-C\s+$/.test(segment)) return true;
  if (/(^|[\s(])terraform\s+-chdir(?:=|\s+)$/.test(segment)) return true;
  if (/(^|\s)(?:--cwd|--workdir|--directory)\s+$/.test(segment)) return true;
  return false;
}

function lastShellSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("\n"), value.lastIndexOf(";"), value.lastIndexOf("|"), value.lastIndexOf("&"));
}

function trimPathPunctuation(value: string): string {
  return value.replace(/^[=:]+/, "").replace(/[.:]+$/, "");
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function maskJsonStringLiterals(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += " ";
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += " ";
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    out += " ";
  }

  return out;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

/**
 * The individual redactable string leaves (values + object keys) of a JSON body; `[body]` for non-JSON.
 * Detection runs over these leaves, not the raw body, so "detected == redactable": a value that appears
 * only as a JSON number leaf is neither detected nor rewritten, and it never trips the fail-closed leak
 * gate. Registered numeric secrets still enter the permanent vault directly.
 */
export function redactableBodyLeaves(body: string): string[] {
  if (!body) return [];
  try {
    const strings: string[] = [];
    collectStrings(JSON.parse(body), strings);
    return strings;
  } catch {
    return [body]; // non-JSON: the entire body is redactable text
  }
}
