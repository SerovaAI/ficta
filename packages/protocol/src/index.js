export const FICTA_HEALTH_PATH = "/__ficta/health";
export const FICTA_STATUS_PATH = "/__ficta/status";
export const FICTA_CONFIG_PATH = "/__ficta/config";

export const EDITABLE_PROXY_CONFIG_KEYS = [
  "failClosed",
  "piiEnabled",
  "piiBackend",
  "piiFailClosed",
  "piiPresidioUrl",
  "secretShapesEnabled",
  "surrogateStyle",
  "restoreIntoTools",
  "allowCustomUpstream",
];

const EDITABLE_PROXY_CONFIG_KEY_SET = new Set(EDITABLE_PROXY_CONFIG_KEYS);

/** @param {unknown} value */
export function isProxyConfigOk(value) {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isRecord(value.config)) return false;
  const { protection, detection, transport } = value.config;
  if (!isRecord(protection) || !isRecord(detection) || !isRecord(transport)) return false;
  if (!isRecord(detection.pii) || !isRecord(detection.secretShapes) || !isRecord(transport.upstreams)) return false;
  return (
    typeof protection.failClosed === "boolean" &&
    typeof protection.requireRegistry === "boolean" &&
    typeof protection.globallyDisabled === "boolean" &&
    typeof protection.redactPaths === "boolean" &&
    typeof protection.restoreIntoTools === "boolean" &&
    (protection.surrogateStyle === "opaque" || protection.surrogateStyle === "typed") &&
    typeof detection.pii.standalone === "boolean" &&
    typeof detection.pii.agents === "boolean" &&
    typeof detection.pii.configuredBackend === "string" &&
    (detection.pii.failureMode === "fail-open" || detection.pii.failureMode === "fail-closed") &&
    typeof detection.secretShapes.standalone === "boolean" &&
    typeof detection.secretShapes.agents === "boolean" &&
    typeof transport.host === "string" &&
    typeof transport.port === "number" &&
    typeof transport.upstreams.anthropic === "string" &&
    typeof transport.upstreams.openai === "string" &&
    typeof transport.upstreams.chatgpt === "string" &&
    (transport.forcedUpstream === undefined || typeof transport.forcedUpstream === "string") &&
    typeof transport.allowCustomUpstream === "boolean" &&
    typeof transport.logLevel === "string" &&
    typeof transport.logBodies === "boolean" &&
    typeof transport.logDir === "string" &&
    isProxyConfigEditState(value.edit)
  );
}

/** @param {unknown} value */
export function isProxyConfigUpdateOk(value) {
  return isRecord(value) && value.ok === true && value.service === "ficta" && isProxyConfigEditState(value.edit);
}

/** @param {unknown} value */
export function isProxyConfigEditState(value) {
  if (!isRecord(value) || !isEditableProxyConfigValues(value.values) || !isRecord(value.locked)) return false;
  if (typeof value.disabled !== "boolean" || typeof value.restartRequired !== "boolean") return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  return Object.entries(value.locked).every(
    ([key, locked]) => EDITABLE_PROXY_CONFIG_KEY_SET.has(key) && typeof locked === "string",
  );
}

/** @param {unknown} value */
export function isEditableProxyConfigValues(value) {
  return (
    isRecord(value) &&
    typeof value.failClosed === "boolean" &&
    typeof value.piiEnabled === "boolean" &&
    (value.piiBackend === "regex" || value.piiBackend === "presidio") &&
    typeof value.piiFailClosed === "boolean" &&
    typeof value.piiPresidioUrl === "string" &&
    typeof value.secretShapesEnabled === "boolean" &&
    (value.surrogateStyle === "opaque" || value.surrogateStyle === "typed") &&
    typeof value.restoreIntoTools === "boolean" &&
    typeof value.allowCustomUpstream === "boolean"
  );
}

/** @param {unknown} value */
export function isProtectionStatusOk(value) {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isRecord(value.protection) || !isRecord(value.secretShapes) || !isRecord(value.pii)) return false;
  if (value.activity !== undefined && !isProtectionActivity(value.activity)) return false;
  return (
    typeof value.protection.enabled === "boolean" &&
    typeof value.protection.protecting === "boolean" &&
    typeof value.protection.registeredValues === "number" &&
    typeof value.protection.policyExcluded === "number" &&
    typeof value.secretShapes.enabled === "boolean" &&
    (value.secretShapes.status === "off" || value.secretShapes.status === "ok") &&
    typeof value.secretShapes.message === "string" &&
    typeof value.pii.enabled === "boolean" &&
    typeof value.pii.configuredBackend === "string" &&
    typeof value.pii.backend === "string" &&
    isPiiStatusState(value.pii.status) &&
    isDetectorFailureMode(value.pii.failureMode) &&
    typeof value.pii.message === "string" &&
    (value.pii.url === undefined || typeof value.pii.url === "string") &&
    (value.pii.detail === undefined || typeof value.pii.detail === "string")
  );
}

/** @param {unknown} value */
function isProtectionActivity(value) {
  return isRecord(value) && typeof value.restoredValues === "number" && typeof value.withheldFromTools === "number";
}

/** @param {unknown} value */
function isPiiStatusState(value) {
  return value === "off" || value === "ok" || value === "degraded" || value === "blocking";
}

/** @param {unknown} value */
function isDetectorFailureMode(value) {
  return value === "fail-open" || value === "fail-closed";
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
