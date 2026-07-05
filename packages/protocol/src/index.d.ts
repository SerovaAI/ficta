export declare const FICTA_HEALTH_PATH = "/__ficta/health";
export declare const FICTA_STATUS_PATH = "/__ficta/status";
export declare const FICTA_CONFIG_PATH = "/__ficta/config";

export type DetectorFailureMode = "fail-open" | "fail-closed";
export type PiiStatusState = "off" | "ok" | "degraded" | "blocking";

export interface PiiProtectionStatus {
  enabled: boolean;
  configuredBackend: string;
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

export interface ProxyConfigPosture {
  protection: {
    failClosed: boolean;
    requireRegistry: boolean;
    globallyDisabled: boolean;
    redactPaths: boolean;
    restoreIntoTools: boolean;
    surrogateStyle: "opaque" | "typed";
  };
  detection: {
    pii: {
      standalone: boolean;
      agents: boolean;
      configuredBackend: string;
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
    logLevel: string;
    logBodies: boolean;
    logDir: string;
  };
}

export type EditableProxyConfigKey =
  | "failClosed"
  | "piiEnabled"
  | "piiBackend"
  | "piiFailClosed"
  | "piiPresidioUrl"
  | "secretShapesEnabled"
  | "surrogateStyle"
  | "restoreIntoTools"
  | "allowCustomUpstream";

export declare const EDITABLE_PROXY_CONFIG_KEYS: readonly EditableProxyConfigKey[];

export interface EditableProxyConfigValues {
  failClosed: boolean;
  piiEnabled: boolean;
  piiBackend: "regex" | "presidio";
  piiFailClosed: boolean;
  piiPresidioUrl: string;
  secretShapesEnabled: boolean;
  surrogateStyle: "opaque" | "typed";
  restoreIntoTools: boolean;
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
export declare function isProxyConfigOk(value: unknown): value is ProxyConfigOk;
export declare function isProxyConfigUpdateOk(value: unknown): value is ProxyConfigUpdateOk;
export declare function isProxyConfigEditState(value: unknown): value is ProxyConfigEditState;
export declare function isEditableProxyConfigValues(value: unknown): value is EditableProxyConfigValues;
