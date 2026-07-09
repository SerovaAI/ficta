export declare const FICTA_HEALTH_PATH = "/__ficta/health";
export declare const FICTA_STATUS_PATH = "/__ficta/status";
export declare const FICTA_CONFIG_PATH = "/__ficta/config";
export declare const FICTA_PROTECTION_STATS_PATH = "/__ficta/protection-stats";
export declare const FICTA_SCOPE_HEADER = "x-ficta-scope";
export declare const FICTA_TRACE_CAPTURE_HEADER = "x-ficta-trace-capture";
export declare const FICTA_RESTORE_HIGHLIGHT_HEADER = "x-ficta-restore-highlights";
export declare const FICTA_RESTORE_HIGHLIGHT_START = "\u001eFICTA_RESTORE_START\u001e";
export declare const FICTA_RESTORE_HIGHLIGHT_METADATA = "\u001eFICTA_RESTORE_SURROGATE\u001e";
export declare const FICTA_RESTORE_HIGHLIGHT_END = "\u001eFICTA_RESTORE_END\u001e";

export type DetectorFailureMode = "fail-open" | "fail-closed";
export type PiiStatusState = "off" | "ok" | "degraded" | "blocking";
export type PiiBackendName = "regex" | "presidio" | "openmed";
export type ProxyLogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * How surrogates the model emits into a tool-call argument are restored on the way back:
 * `all` restores every mapped token (registry secrets included), `none` withholds every token, and
 * `detected` (the default) restores content the agent already read locally while keeping registry
 * secrets as placeholders.
 */
export type RestoreIntoToolsPolicy = "all" | "none" | "detected";

export declare const PII_BACKEND_NAMES: readonly PiiBackendName[];
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

export interface ProtectionStatusOk {
  ok: true;
  service: "ficta";
  protection: {
    enabled: boolean;
    protecting: boolean;
    registeredValues: number;
    policyExcluded: number;
  };
  secretShapes: SecretShapeProtectionStatus;
  pii: PiiProtectionStatus;
  activity?: {
    restoredValues: number;
    withheldFromTools: number;
  };
}

export interface ProtectionStatusError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProtectionStatus = ProtectionStatusOk | ProtectionStatusError;

export type ProtectionStatsSurface = "body" | "query string" | "non-auth headers";

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
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
  restoredValues: number;
  withheldFromToolsValues: number;
}

export interface ProtectionStatsBucket {
  name: string;
  requests: number;
  redactedValues: number;
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

export interface ProtectionStatsError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProtectionStats = ProtectionStatsOk | ProtectionStatsError;

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
    traceAudit: boolean;
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

export interface ProxyConfigError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProxyConfig = ProxyConfigOk | ProxyConfigError;

export interface ProxyConfigUpdateOk {
  ok: true;
  service: "ficta";
  edit: ProxyConfigEditState;
}

export interface ProxyConfigUpdateError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProxyConfigUpdate = ProxyConfigUpdateOk | ProxyConfigUpdateError;

export interface ProxyConfigPatchError {
  ok: false;
  service: "ficta";
  status: "disabled" | "invalid_patch" | "locked";
  message: string;
  field?: EditableProxyConfigKey;
}

export type ProxyConfigPatchResponse = ProxyConfigUpdateOk | ProxyConfigPatchError;

export declare function isProtectionStatusOk(value: unknown): value is ProtectionStatusOk;
export declare function isProtectionStatsOk(value: unknown): value is ProtectionStatsOk;
export declare function isProxyConfigOk(value: unknown): value is ProxyConfigOk;
export declare function isProxyConfigUpdateOk(value: unknown): value is ProxyConfigUpdateOk;
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
