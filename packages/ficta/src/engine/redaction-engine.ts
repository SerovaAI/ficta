import type {
  DetectionProfile,
  DetectTextContext,
  PluginDiscovery,
  ProtectedValue,
  RegistryPolicy,
} from "./plugins/types.js";
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
   *
   * `opts.detectionProfile` widens best-effort detection for this scope (additive-only jurisdiction
   * bundles — see `plugins/pii/jurisdictions.ts`). For keyed scopes a profile change invalidates the
   * swept-leaf cache so previously skipped content is re-swept under the new profile.
   */
  beginRequest(scopeKey?: string, opts?: RequestScopeOptions): RequestScope;

  // --- Diagnostics / introspection consumed by the proxy startup banner + ProxyHandle. ---

  /** Number of protected values currently loaded. */
  readonly size: number;

  /** Safe registry-source diagnostics and policy metadata. Never includes protected values. */
  readonly registryStatus: EngineRegistryStatus;

  /**
   * Re-run the registry-source plugins and register any new values live (additions only — deletions
   * apply on restart). Optional: engines without a reloadable registry simply omit it, and the proxy's
   * reload endpoint reports the capability as unavailable.
   */
  reloadRegistryValues?(): { added: number; total: number; restartRequired?: boolean };
}

/** Values-free engine diagnostics consumed by the proxy status, banner, and returned handle. */
export interface EngineRegistryStatus {
  readonly discoveries: readonly PluginDiscovery[];
  readonly registryPolicy: RegistryPolicy;
  readonly policyExcluded: number;
  readonly policyExcludedBySource: Readonly<Record<string, number>>;
}

/**
 * A request-scoped redact/restore surface. Detection performed through it registers into an
 * ephemeral per-request layer (not the shared permanent vault); restore consults that layer first,
 * then the permanent one. Obtained from {@link RedactionEngine.beginRequest}; used by the proxy for
 * exactly one request and then discarded.
 */
/** Per-scope options supplied by the trusted caller at {@link RedactionEngine.beginRequest}. */
export interface RequestScopeOptions {
  /** Additive-only jurisdiction widening for this scope's best-effort detection. */
  detectionProfile?: DetectionProfile;
}

export interface RequestScope {
  /**
   * Admit explicit user-selected values into this trusted scope with registry-strength provenance.
   * These values remain request-local and are never added to the process registry or keyed detector state.
   */
  registerProtectedValues(values: readonly ProtectedValue[]): void;

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
   * Distinct surrogate-shaped tokens that survived this request's restore with no dictionary mapping
   * (model-mutated, truncated, or invented — token debris forwarded to the client as-is). Values-free
   * restore-failure observability; read alongside {@link restoredCount} to log the
   * `⚠️ N unrestored surrogate token(s)` line.
   */
  readonly residualSurrogateCount: number;

  /**
   * Raw restore audit for explicit trace/debug runs. This includes protected values and must only be
   * written when runtime capture and raw-value auditing (`FICTA_TRACE_AUDIT=1`) are enabled, never
   * surfaced in normal stats.
   */
  traceRestoreDetails(): RestoreTraceDetails;
}

interface TraceRedactionOptions {
  /**
   * Include raw values and surrogates in the returned detail object. This is for explicitly enabled
   * proxy audit sidecars; normal callers should leave it unset so detailed redaction stays values-free.
   */
  traceValues?: boolean;

  /**
   * Include the resolver's exact leaf-local replacement ranges. This is used by the loopback-only
   * protection preview so the UI renders the same occurrence plan as body redaction. Coordinates
   * and metadata are safe; the caller already owns the source document and no raw value is copied
   * into the returned occurrence.
   */
  traceOccurrences?: boolean;
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

/** Exact resolver output for one replacement in a body string leaf. */
export interface ProtectionTraceOccurrence extends ProtectionHit {
  leaf: number;
  start: number;
  end: number;
  surrogate: string;
  origin: "registry" | "detected" | "user";
}

/** Values-free trace-only detail for one ambiguous inferred organization mention. */
export interface AmbiguousEntityLinkDiagnostic {
  code: "AMBIGUOUS_ENTITY_LINK";
  linkingRule: "organization_short_name";
  leaf: number;
  start: number;
  end: number;
  candidateCount: number;
  /** Stable one-way identifiers for local correlation; never raw registry ids. */
  candidateEntityIds: string[];
  /** Present for a trusted keyed request scope; never the raw scope key. */
  contextHash?: string;
}

export interface RestoreTraceDetails {
  restored: ProtectionTraceValue[];
  withheldFromTools: ProtectionTraceValue[];
}

export interface RestoreMarkers {
  start: string;
  /** Optional delimiter followed by the winning protection origin (`registry`, `detected`, or `user`). */
  origin?: string;
  metadata?: string;
  end: string;
}

export interface RestoreOptions {
  /**
   * Optional client-facing markers around restored human text. Used by clients that explicitly
   * advertise restore-highlight support; callers must strip or render them before resending transcripts.
   */
  markers?: RestoreMarkers;
}

/** Mirrors the public protocol's ProtectionPreviewOrigin without coupling the engine boundary to product packages. */
export type RestoreOrigin = "registry" | "detected" | "user";

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
  /** Safe metadata, one entry per distinct redacted value/surface (labels may repeat). */
  hits: ProtectionHit[];
  /** Safe metadata, one entry per distinct surviving known value (labels may repeat). */
  leakHits: ProtectionHit[];
  /** Ambiguous inferred entity mentions that remained protected through the literal path. */
  ambiguousEntityLinks: number;
  traceValues?: ProtectionTraceValue[];
  traceLeakValues?: ProtectionTraceValue[];
  traceOccurrences?: ProtectionTraceOccurrence[];
  traceAmbiguousEntityLinks?: AmbiguousEntityLinkDiagnostic[];
}

export interface TextRedactionDetails extends TextRedactionResult {
  /** Safe metadata, one entry per distinct redacted value (labels may repeat). */
  hits: ProtectionHit[];
  /** Safe metadata, one entry per distinct surviving known value (labels may repeat). */
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

/**
 * An internal coordinate/re-anchor failure. Unlike operator-tunable leak and detector policy, this
 * always blocks forwarding because continuing would knowingly use a corrupted redaction plan.
 */
export class RedactionInvariantError extends Error {
  constructor(readonly reason: string) {
    super(`redaction invariant failed: ${reason}`);
    this.name = "RedactionInvariantError";
  }
}
