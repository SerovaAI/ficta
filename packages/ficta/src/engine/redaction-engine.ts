import type { PluginRegistrySnapshot } from "./plugins/registry.js";
import type { DetectTextContext, ProtectedValue } from "./plugins/types.js";
import type { Wire } from "./wire.js";

/**
 * The redaction contract the proxy (`server.ts`) depends on — the seam that lets an engine be
 * swapped without touching the transport. `ProtectionEngine` is the built-in implementation; a
 * different engine (e.g. a per-tenant or remote one) only has to satisfy this interface.
 *
 * Invariant preserved by any implementation: it may only redact (tokenize) outbound data and
 * restore it on responses — it never sees or forwards auth headers, and never logs raw values.
 */
export interface RedactionEngine {
  /** True when the engine may transform outbound data (has registered values or detectors). */
  readonly enabled: boolean;

  /** True when protection is actually configured (registered values or an active detector). */
  readonly protecting: boolean;

  /**
   * Redact a request body (JSON-aware) and report which values matched / leaked. Async because
   * detection may hit an out-of-process recognizer (e.g. a Presidio/NER sidecar).
   */
  redactBodyDetailed(body: string, ctx?: BodyRedactionContext): Promise<BodyRedactionDetails>;

  /** Redact a raw string (header value, query component) and report matches / leaks. Async: see above. */
  redactTextDetailed(text: string, ctx?: TextRedactionContext): Promise<TextRedactionDetails>;

  /** Restore surrogates → real values in a chunk of text. */
  restoreText(text: string, opts?: RestoreOptions): string;

  /**
   * Restore surrogates in a JSON body, escaping each restored value for its string context. With a
   * known `wire`, tool-call arguments get the same restore-into-tools withholding as the SSE path.
   */
  restoreJson(body: string, wire?: Wire, opts?: RestoreOptions): string;

  /** Streaming restore for non-SSE response bodies (holds back partial surrogates at chunk edges). */
  restoreStream(opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array>;

  /** Streaming restore for a provider SSE stream, using the wire-specific reassembly adapter. */
  restoreEventStream(wire: Wire, opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array>;

  /** Conservative membership check used to keep derived metadata (paths, model names) safe to log. */
  containsProtectedValue(text: string): boolean;

  /**
   * Open a request-scoped view of the engine. Registered secrets (the permanent layer) are shared
   * and unchanged; values detected while redacting this request live in a detected layer that is
   * consulted only within the scope. Without a `scopeKey` that layer is ephemeral — discarded when
   * the returned scope is dropped, so one request's detected values are never restored into
   * another's response. With a `scopeKey` (derived by a trusted caller, e.g. an org:thread pair)
   * the detected layer persists across the key's requests under TTL/LRU bounds, and the same
   * isolation guarantee holds *across keys*. The engine's own `redactBodyDetailed` /
   * `restoreText` / … operate on a single implicit default scope — the degenerate CLI case.
   */
  beginRequest(scopeKey?: string): RequestScope;

  // --- Diagnostics / introspection consumed by the proxy startup banner + ProxyHandle. ---

  /** Number of protected values currently loaded. */
  readonly size: number;

  /** Safe launch-time snapshot of registry-source discovery (counts, names — never values). */
  readonly registry: PluginRegistrySnapshot;

  /**
   * Re-run the registry-source plugins and register any new values live (additions only — deletions
   * apply on restart). Optional: engines without a reloadable registry simply omit it, and the proxy's
   * reload endpoint reports the capability as unavailable.
   */
  reloadRegistryValues?(): { added: number; total: number };
}

/**
 * A request-scoped redact/restore surface. Detection performed through it registers into an
 * ephemeral per-request layer (not the shared permanent vault); restore consults that layer first,
 * then the permanent one. Obtained from {@link RedactionEngine.beginRequest}; used by the proxy for
 * exactly one request and then discarded.
 */
export interface RequestScope {
  /** Redact a request body (JSON-aware); detected values enter this scope's ephemeral layer. */
  redactBodyDetailed(body: string, ctx?: BodyRedactionContext): Promise<BodyRedactionDetails>;

  /** Redact a raw string (header value, query component); detected values enter this scope. */
  redactTextDetailed(text: string, ctx?: TextRedactionContext): Promise<TextRedactionDetails>;

  /** Restore surrogates → real values in a chunk of text (scope-detected then permanent). */
  restoreText(text: string, opts?: RestoreOptions): string;

  /**
   * Restore surrogates in a JSON body, escaping each restored value for its string context. With a
   * known `wire`, tool-call arguments get the same restore-into-tools withholding as the SSE path.
   */
  restoreJson(body: string, wire?: Wire, opts?: RestoreOptions): string;

  /** Streaming restore for non-SSE response bodies (holds back partial surrogates at chunk edges). */
  restoreStream(opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array>;

  /** Streaming restore for a provider SSE stream, using the wire-specific reassembly adapter. */
  restoreEventStream(wire: Wire, opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array>;

  /** Membership check over permanent + this scope's detected values, to keep derived metadata safe to log. */
  containsProtectedValue(text: string): boolean;

  /**
   * Distinct minted surrogate tokens present in `text` (permanent + this scope's detected layer). Used to
   * build the model's preserve-literals allow-list from an already-redacted outbound body — the tokens
   * are opaque surrogates, never raw protected values.
   */
  mintedSurrogatesIn(text: string): string[];

  /**
   * Distinct values restored back into this request's response so far. Read after the response body
   * drains (streaming) or is built (buffered) to log the symmetric `♻️ restored N value(s)` line.
   */
  readonly restoredCount: number;

  /**
   * Distinct values withheld from tool-call arguments in this request's response (restore-into-tools
   * withholding — a placeholder reached the tool instead of the real secret). Read alongside
   * {@link restoredCount} to log the `🛡️ withheld N value(s) from tool-call arguments` line.
   */
  readonly withheldFromToolsCount: number;

  /**
   * Raw restore audit for explicit trace/debug runs. This includes protected values and must only be
   * written when raw-value auditing is explicitly enabled (`FICTA_LOG_LEVEL=trace` and
   * `FICTA_TRACE_AUDIT=1`), never surfaced in normal stats.
   */
  traceRestoreDetails(): RestoreTraceDetails;
}

interface TraceRedactionOptions {
  /**
   * Include raw values and surrogates in the returned detail object. This is for explicitly enabled
   * proxy audit sidecars; normal callers should leave it unset so detailed redaction stays values-free.
   */
  traceValues?: boolean;
}

export type BodyRedactionContext = Omit<DetectTextContext, "surface"> & TraceRedactionOptions;

/** Optional context for text redaction: which surface/header/path the text came from. */
export type TextRedactionContext = Omit<DetectTextContext, "surface"> &
  TraceRedactionOptions & {
    surface?: DetectTextContext["surface"];
    /**
     * Keep registered/detected values that sit inside a filesystem-path-like token untouched. Default
     * true (the query surface, where paths like `redirect_uri=/a/b` are legitimate). The proxy passes
     * false for headers so a secret embedded in a slash-path there is redacted, not preserved.
     */
    preservePaths?: boolean;
  };

/** Safe metadata about a protected value that matched. Never includes the protected literal. */
export interface ProtectionHit {
  name: string;
  source: string;
  plugin?: string;
  kind?: ProtectedValue["kind"];
  confidence?: ProtectedValue["confidence"];
}

/** Trace-only protected value detail. Contains raw values; never include in default stats/logs. */
export interface ProtectionTraceValue extends ProtectionHit {
  value: string;
  valueSha256: string;
  surrogate?: string;
  provenance?: "permanent" | "detected";
}

export interface RestoreTraceDetails {
  restored: ProtectionTraceValue[];
  withheldFromTools: ProtectionTraceValue[];
}

export interface RestoreMarkers {
  start: string;
  metadata?: string;
  end: string;
}

export interface RestoreOptions {
  /**
   * Optional client-facing markers around restored human text. Used by the Gateway trace demo to
   * render highlights; callers must strip or render these markers before resending transcripts.
   */
  markers?: RestoreMarkers;
}

export interface BodyRedactionResult {
  body: string;
  count: number;
  leaks: number;
}

export interface TextRedactionResult {
  text: string;
  count: number;
  leaks: number;
}

export interface BodyRedactionDetails extends BodyRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
  traceValues?: ProtectionTraceValue[];
  traceLeakValues?: ProtectionTraceValue[];
}

export interface TextRedactionDetails extends TextRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
  traceValues?: ProtectionTraceValue[];
  traceLeakValues?: ProtectionTraceValue[];
}

/**
 * Neutral signal from a detector that its backend could not run (e.g. an out-of-process recognizer
 * is unreachable). It carries no policy — the *core* decides whether an outage is fatal, resolving the
 * per-plugin `failClosed()` override against the global default and either re-raising this to block the
 * request or swallowing it to continue best-effort. `reason` is safe metadata (failure category) —
 * never request text or protected values.
 */
export class DetectorUnavailableError extends Error {
  constructor(
    readonly plugin: string,
    readonly reason?: string,
  ) {
    super(reason ? `detector "${plugin}" unavailable: ${reason}` : `detector "${plugin}" unavailable`);
    this.name = "DetectorUnavailableError";
  }
}
