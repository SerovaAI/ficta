export declare const FICTA_HEALTH_PATH = "/__ficta/health";
export declare const FICTA_STATUS_PATH = "/__ficta/status";
export declare const FICTA_CONFIG_PATH = "/__ficta/config";
export declare const FICTA_TRACE_CAPTURE_PATH = "/__ficta/trace-capture";
export declare const FICTA_REGISTRY_RELOAD_PATH = "/__ficta/registry/reload";
export declare const FICTA_REGISTRY_REVISION_HEADER = "x-ficta-registry-revision";
export declare const FICTA_PROTECTION_STATS_PATH = "/__ficta/protection-stats";
/** Loopback-only, values-free proof for one provider-bound request. */
export declare const FICTA_EGRESS_PROOF_PATH = "/__ficta/egress-proof";
export declare const FICTA_PROTECTION_PREVIEW_PATH = "/__ficta/protection-preview";
export declare const FICTA_PROTECTION_TICKET_HEADER = "x-ficta-protection-ticket";
export declare const FICTA_SCOPE_HEADER = "x-ficta-scope";
/**
 * Comma-separated jurisdiction codes widening best-effort PII detection for one request.
 * Additive-only: codes enable extra detectors on top of the global baseline, never disable any,
 * so a spoofed header can only over-redact. Never forwarded upstream.
 */
export declare const FICTA_DETECTION_PROFILE_HEADER = "x-ficta-detection-profile";
/** Correlates a Gateway audit record with one proxy request. Never forwarded upstream. */
export declare const FICTA_EGRESS_EVENT_HEADER = "x-ficta-egress-event";
export declare const FICTA_TRACE_CAPTURE_HEADER = "x-ficta-trace-capture";
export declare const FICTA_RESTORE_HIGHLIGHT_HEADER = "x-ficta-restore-highlights";
export declare const FICTA_RESTORE_HIGHLIGHT_START = "\u001eFICTA_RESTORE_START\u001e";
export declare const FICTA_RESTORE_HIGHLIGHT_ORIGIN = "\u001eFICTA_RESTORE_ORIGIN\u001e";
export declare const FICTA_RESTORE_HIGHLIGHT_METADATA = "\u001eFICTA_RESTORE_SURROGATE\u001e";
export declare const FICTA_RESTORE_HIGHLIGHT_END = "\u001eFICTA_RESTORE_END\u001e";
export declare const FICTA_MANAGED_REGISTRY_SCHEMA = "ficta.managed-registry.v1";

export type DetectorFailureMode = "fail-open" | "fail-closed";
export type DetectionJurisdiction = "za" | "uk" | "us";
export type PiiStatusState = "off" | "ok" | "degraded" | "blocking";
export type PiiBackendName = "regex" | "presidio" | "openmed";
export type ProxyLogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export interface RuntimeTraceCaptureState {
  enabled: boolean;
}

export interface RuntimeTraceCaptureOk {
  ok: true;
  service: "ficta";
  traceCapture: RuntimeTraceCaptureState;
}

export interface RuntimeTraceCaptureError {
  ok: false;
  service: "ficta";
  status: "forbidden" | "invalid_patch";
  message: string;
}

export type RuntimeTraceCaptureResponse = RuntimeTraceCaptureOk | RuntimeTraceCaptureError;

/**
 * How surrogates the model emits into a tool-call argument are restored on the way back:
 * `all` restores every mapped token (registry secrets included), `none` withholds every token, and
 * `detected` (the default) restores content the agent already read locally while keeping registry
 * secrets as placeholders.
 */
export type RestoreIntoToolsPolicy = "all" | "none" | "detected";

export declare const PII_BACKEND_NAMES: readonly PiiBackendName[];
/** Jurisdiction codes accepted in the detection-profile header; unknown codes are dropped. */
export declare const SUPPORTED_DETECTION_JURISDICTIONS: readonly DetectionJurisdiction[];
export declare function isDetectionJurisdiction(value: unknown): value is DetectionJurisdiction;
export declare const RESTORE_INTO_TOOLS_POLICIES: readonly RestoreIntoToolsPolicy[];
export declare const PROXY_LOG_LEVELS: readonly ProxyLogLevel[];

export interface PiiProtectionStatus {
  enabled: boolean;
  configuredBackend: string;
  configuredBackends?: string[];
  backend: string;
  status: PiiStatusState;
  failureMode: DetectorFailureMode;
  url?: string;
  detail?: string;
  message: string;
}

export interface SecretShapeProtectionStatus {
  enabled: boolean;
  status: "off" | "ok";
  message: string;
}

export type RegistryProtectionState = "ready" | "empty" | "error";

/** Values-free readiness of the exact-match registry used to gate provider-bound traffic. */
export interface RegistryProtectionStatus {
  required: boolean;
  status: RegistryProtectionState;
  message: string;
}

export interface ProtectionStatusOk {
  ok: true;
  service: "ficta";
  protection: {
    enabled: boolean;
    protecting: boolean;
    registeredValues: number;
    policyExcluded: number;
  };
  /** Optional for compatibility with proxies released before runtime registry readiness gating. */
  registry?: RegistryProtectionStatus;
  secretShapes: SecretShapeProtectionStatus;
  pii: PiiProtectionStatus;
  activity?: {
    restoredValues: number;
    withheldFromTools: number;
  };
}

export type ProtectionPreviewOrigin = "registry" | "detected" | "user";

/** UTF-16 coordinates into the exact preview text supplied by the caller. */
export interface ProtectionPreviewFinding extends ProtectionHit {
  start: number;
  end: number;
  surrogate: string;
  origin: ProtectionPreviewOrigin;
}

/** Loopback-only request used to inspect and prepare one outbound chat message. */
export interface ProtectionPreviewRequest {
  text: string;
  /** User-selected values to apply with registry-strength provenance inside this trusted scope. */
  protectedValues?: string[];
}

export interface ProtectionPreviewOk {
  ok: true;
  service: "ficta";
  ticket: string;
  /** SHA-256 of `text`; the proxy binds the single-use ticket to the final outbound user message. */
  textSha256: string;
  redactedText: string;
  findings: ProtectionPreviewFinding[];
}

export interface ProtectionPreviewError {
  ok: false;
  service: "ficta";
  status: "forbidden" | "invalid_request" | "detector_unavailable" | "invariant";
  message: string;
}

export type ProtectionPreview = ProtectionPreviewOk | ProtectionPreviewError;
export type ProtectionStatsSurface = "body" | "query string" | "non-auth headers";
export type ProtectionStatsBlockReason = "detector_unavailable";

export interface ProtectionHit {
  name: string;
  source: string;
  plugin?: string;
  kind?: "secret" | "pii" | "custom";
  confidence?: "exact" | "high" | "probabilistic";
}

export interface ProtectionStatsTotals {
  events: number;
  affectedRequests: number;
  redactedValues: number;
  /** Registered or detected values still present after redaction; excludes PII the detectors never recognized. */
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
  restoredValues: number;
  withheldFromToolsValues: number;
  /**
   * Surrogate-shaped tokens that survived restore with no dictionary mapping — mutated, truncated,
   * or invented by the model (e.g. a wildcard family reference) and forwarded to the client as-is.
   * Values-free token count. Optional: absent from snapshots written by older ficta versions.
   */
  residualSurrogateValues?: number;
  /** Ambiguous inferred organization mention occurrences protected through the literal path. */
  ambiguousEntityLinks: number;
  /** Distinct requests containing at least one ambiguous inferred organization mention. */
  ambiguousEntityLinkRequests: number;
}

export interface ProtectionStatsBucket {
  name: string;
  requests: number;
  redactedValues: number;
  /** Registered or detected values still present after redaction; excludes undetected PII. */
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
}

export interface ProtectionStatsLabelBucket extends ProtectionStatsBucket {
  source: string;
  plugin?: string;
  kind?: ProtectionHit["kind"];
  confidence?: ProtectionHit["confidence"];
}

export interface ProtectionStatsEvent {
  index: number;
  at: string;
  requestId?: number;
  method: string;
  path: string;
  wire: string;
  route?: string;
  model: string;
  surface: ProtectionStatsSurface;
  redactedValues: number;
  survivingValues: number;
  blocked: boolean;
  /** Values-free count of ambiguous inferred entity mentions on this event surface. */
  ambiguousEntityLinks: number;
  /** Values-free reason for a request blocked before ordinary redaction proof was available. */
  blockReason?: ProtectionStatsBlockReason;
  redactedHits: ProtectionHit[];
  survivingHits: ProtectionHit[];
}

export interface ProtectionStatsSnapshot {
  version: 1;
  path: string;
  startedAt: string;
  updatedAt: string;
  totals: ProtectionStatsTotals;
  byModel: ProtectionStatsBucket[];
  bySurface: ProtectionStatsBucket[];
  byWire: ProtectionStatsBucket[];
  byLabel: ProtectionStatsLabelBucket[];
  events: ProtectionStatsEvent[];
}

export interface ProtectionStatsOk {
  ok: true;
  service: "ficta";
  stats: ProtectionStatsSnapshot;
}

/** Values-free result for one Gateway-correlated provider request. */
export interface EgressProofLabel extends ProtectionHit {
  /** Distinct protected values tokenized under this label. Optional on receipts created before label counts. */
  redactedValues?: number;
  /** Known values under this label that survived redaction. Optional on older receipts. */
  survivingValues?: number;
}

export interface EgressProof {
  eventId: string;
  at: string;
  outcome: "forwarded" | "blocked" | "upstream_error";
  screening: "completed" | "detector_unavailable" | "not_configured";
  model: string;
  redactedValues: number;
  /** Registered or detected values that survived redaction; undetected PII is outside this proof. */
  survivingValues: number;
  /** Values-free count of ambiguous inferred entity mentions protected on this request. */
  ambiguousEntityLinks: number;
  labels: EgressProofLabel[];
}

export interface EgressProofOk {
  ok: true;
  service: "ficta";
  proof: EgressProof;
}

export declare function isEgressProofOk(value: unknown): value is EgressProofOk;

export interface ProxyConfigPosture {
  protection: {
    failClosed: boolean;
    requireRegistry: boolean;
    globallyDisabled: boolean;
    redactPaths: boolean;
    restoreIntoTools: RestoreIntoToolsPolicy;
    surrogateStyle: "opaque" | "typed";
  };
  detection: {
    pii: {
      standalone: boolean;
      agents: boolean;
      configuredBackend: string;
      configuredBackends: string[];
      failureMode: DetectorFailureMode;
    };
    secretShapes: {
      standalone: boolean;
      agents: boolean;
    };
  };
  transport: {
    host: string;
    port: number;
    upstreams: { anthropic: string; openai: string; chatgpt: string };
    forcedUpstream?: string;
    allowCustomUpstream: boolean;
    logLevel: ProxyLogLevel;
    logBodies: boolean;
    /** Operator-enabled capability; files still require active runtime and per-request capture grants. */
    traceAudit: boolean;
    traceCapture: RuntimeTraceCaptureState;
    logDir: string;
  };
}

export type EditableProxyConfigKey =
  | "failClosed"
  | "piiEnabled"
  | "piiBackends"
  | "piiFailClosed"
  | "piiPresidioUrl"
  | "piiOpenmedUrl"
  | "secretShapesEnabled"
  | "surrogateStyle"
  | "restoreIntoTools"
  | "allowCustomUpstream";

export declare const EDITABLE_PROXY_CONFIG_KEYS: readonly EditableProxyConfigKey[];

export interface EditableProxyConfigValues {
  failClosed: boolean;
  piiEnabled: boolean;
  piiBackends: PiiBackendName[];
  piiFailClosed: boolean;
  piiPresidioUrl: string;
  piiOpenmedUrl: string;
  secretShapesEnabled: boolean;
  surrogateStyle: "opaque" | "typed";
  restoreIntoTools: RestoreIntoToolsPolicy;
  allowCustomUpstream: boolean;
}

export interface ProxyConfigEditState {
  path?: string;
  disabled: boolean;
  restartRequired: boolean;
  values: EditableProxyConfigValues;
  locked: Partial<Record<EditableProxyConfigKey, string>>;
}

export interface ProxyConfigOk {
  ok: true;
  service: "ficta";
  config: ProxyConfigPosture;
  edit: ProxyConfigEditState;
}

export interface ProxyConfigUpdateOk {
  ok: true;
  service: "ficta";
  edit: ProxyConfigEditState;
}

export interface ProxyConfigPatchError {
  ok: false;
  service: "ficta";
  status: "disabled" | "forbidden" | "invalid_patch" | "locked";
  message: string;
  field?: EditableProxyConfigKey;
}

export type ProxyConfigPatchResponse = ProxyConfigUpdateOk | ProxyConfigPatchError;

/** Success shape of POST /__ficta/registry/reload — counts only, never values. */
export interface RegistryReloadOk {
  ok: true;
  service: "ficta";
  registry: {
    /** Newly registered values this reload (0 when the file is unchanged). */
    added: number;
    /** Live count of registered values in the running proxy after the reload. */
    total: number;
    /** Values accepted from the currently configured managed-registry files. */
    loaded?: number;
    /** Managed-registry source health. */
    filesRead?: number;
    filesMissing?: number;
    filesErrored?: number;
    /** The caller's expected file revision, only when that exact revision was parsed by the proxy. */
    revision?: string;
    /** True when the file is valid but modifies/removes a record already active in this process. */
    restartRequired?: boolean;
  };
}

export interface RegistryReloadError {
  ok: false;
  service: "ficta";
  status: "forbidden" | "unsupported" | "invalid_registry";
  message: string;
}

export type RegistryReloadResponse = RegistryReloadOk | RegistryReloadError;

export type ManagedRegistryFormBoundary = "substring" | "token";
export type ManagedRegistryEntityType = "organization" | "person";
export type ManagedRegistryFormKind = "legal_name" | "full_name" | "short_name" | "alias";

export interface ManagedRegistryEntityForm {
  value: string;
  kind: ManagedRegistryFormKind;
  boundary: ManagedRegistryFormBoundary;
}

export interface ManagedRegistryEntityEntry {
  id: string;
  protectionKind: "entity";
  entityType: ManagedRegistryEntityType;
  canonicalValue: string;
  forms: ManagedRegistryEntityForm[];
}

export interface ManagedRegistryLiteralEntry {
  id: string;
  protectionKind: "literal";
  value: string;
  semanticType?: string;
}

export type ManagedRegistryEntry = ManagedRegistryEntityEntry | ManagedRegistryLiteralEntry;

export interface ManagedRegistryFile {
  schema: typeof FICTA_MANAGED_REGISTRY_SCHEMA;
  revision: string;
  generatedBy: string;
  generatedAt: string;
  entries: ManagedRegistryEntry[];
}

export declare function isProtectionStatusOk(value: unknown): value is ProtectionStatusOk;
export declare function isProtectionPreviewOk(value: unknown): value is ProtectionPreviewOk;
export declare function isProtectionStatsOk(value: unknown): value is ProtectionStatsOk;
export declare function isProxyConfigOk(value: unknown): value is ProxyConfigOk;
export declare function isRuntimeTraceCaptureOk(value: unknown): value is RuntimeTraceCaptureOk;
export declare function isRuntimeTraceCaptureState(value: unknown): value is RuntimeTraceCaptureState;
export declare function isProxyConfigUpdateOk(value: unknown): value is ProxyConfigUpdateOk;
export declare function isRegistryReloadOk(value: unknown): value is RegistryReloadOk;
export declare function isRegistryReloadError(value: unknown): value is RegistryReloadError;
export declare function isManagedRegistryFile(value: unknown): value is ManagedRegistryFile;
export declare function isProxyConfigEditState(value: unknown): value is ProxyConfigEditState;
export declare function isEditableProxyConfigValues(value: unknown): value is EditableProxyConfigValues;
export declare function isPiiBackendName(value: unknown): value is PiiBackendName;
export declare function normalizePiiBackends(value: unknown): PiiBackendName[] | undefined;
export declare function isRestoreIntoToolsPolicy(value: unknown): value is RestoreIntoToolsPolicy;
export declare function isProxyLogLevel(value: unknown): value is ProxyLogLevel;
/**
 * Coerce a value to a {@link RestoreIntoToolsPolicy}: the three policy names pass through; the
 * historical booleans map `true`→`all` / `false`→`none` for cross-version tolerance; anything else
 * is `undefined`.
 */
export declare function normalizeRestoreIntoToolsPolicy(value: unknown): RestoreIntoToolsPolicy | undefined;
