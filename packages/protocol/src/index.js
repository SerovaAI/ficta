export const FICTA_HEALTH_PATH = "/__ficta/health";
export const FICTA_STATUS_PATH = "/__ficta/status";
export const FICTA_CONFIG_PATH = "/__ficta/config";
export const FICTA_TRACE_CAPTURE_PATH = "/__ficta/trace-capture";
export const FICTA_REGISTRY_RELOAD_PATH = "/__ficta/registry/reload";
export const FICTA_REGISTRY_REVISION_HEADER = "x-ficta-registry-revision";
export const FICTA_PROTECTION_STATS_PATH = "/__ficta/protection-stats";
export const FICTA_PROTECTION_PREVIEW_PATH = "/__ficta/protection-preview";
export const FICTA_PROTECTION_TICKET_HEADER = "x-ficta-protection-ticket";
export const FICTA_SCOPE_HEADER = "x-ficta-scope";
export const FICTA_TRACE_CAPTURE_HEADER = "x-ficta-trace-capture";
export const FICTA_RESTORE_HIGHLIGHT_HEADER = "x-ficta-restore-highlights";
export const FICTA_RESTORE_HIGHLIGHT_START = "\u001eFICTA_RESTORE_START\u001e";
export const FICTA_RESTORE_HIGHLIGHT_METADATA = "\u001eFICTA_RESTORE_SURROGATE\u001e";
export const FICTA_RESTORE_HIGHLIGHT_END = "\u001eFICTA_RESTORE_END\u001e";
export const FICTA_MANAGED_REGISTRY_SCHEMA = "ficta.managed-registry.v1";

export const PII_BACKEND_NAMES = ["regex", "presidio", "openmed"];
const PII_BACKEND_NAME_SET = new Set(PII_BACKEND_NAMES);

export const RESTORE_INTO_TOOLS_POLICIES = ["all", "none", "detected"];
const RESTORE_INTO_TOOLS_POLICY_SET = new Set(RESTORE_INTO_TOOLS_POLICIES);

export const PROXY_LOG_LEVELS = ["silent", "error", "warn", "info", "debug", "trace"];
const PROXY_LOG_LEVEL_SET = new Set(PROXY_LOG_LEVELS);

export const EDITABLE_PROXY_CONFIG_KEYS = [
  "failClosed",
  "piiEnabled",
  "piiBackends",
  "piiFailClosed",
  "piiPresidioUrl",
  "piiOpenmedUrl",
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
  if (
    !isRecord(detection.pii) ||
    !isRecord(detection.secretShapes) ||
    !isRecord(transport.upstreams) ||
    !isRuntimeTraceCaptureState(transport.traceCapture)
  )
    return false;
  return (
    typeof protection.failClosed === "boolean" &&
    typeof protection.requireRegistry === "boolean" &&
    typeof protection.globallyDisabled === "boolean" &&
    typeof protection.redactPaths === "boolean" &&
    isRestoreIntoToolsPolicy(protection.restoreIntoTools) &&
    (protection.surrogateStyle === "opaque" || protection.surrogateStyle === "typed") &&
    typeof detection.pii.standalone === "boolean" &&
    typeof detection.pii.agents === "boolean" &&
    typeof detection.pii.configuredBackend === "string" &&
    isStringArray(detection.pii.configuredBackends) &&
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
    isProxyLogLevel(transport.logLevel) &&
    typeof transport.logBodies === "boolean" &&
    typeof transport.traceAudit === "boolean" &&
    typeof transport.logDir === "string" &&
    isProxyConfigEditState(value.edit)
  );
}

/** @param {unknown} value */
export function isRuntimeTraceCaptureOk(value) {
  return (
    isRecord(value) && value.ok === true && value.service === "ficta" && isRuntimeTraceCaptureState(value.traceCapture)
  );
}

/** @param {unknown} value */
export function isRuntimeTraceCaptureState(value) {
  return isRecord(value) && typeof value.enabled === "boolean";
}

/** @param {unknown} value */
export function isProxyConfigUpdateOk(value) {
  return isRecord(value) && value.ok === true && value.service === "ficta" && isProxyConfigEditState(value.edit);
}

/** @param {unknown} value */
export function isRegistryReloadOk(value) {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isRecord(value.registry)) return false;
  return (
    isNonNegativeInteger(value.registry.added) &&
    isNonNegativeInteger(value.registry.total) &&
    (value.registry.loaded === undefined || isNonNegativeInteger(value.registry.loaded)) &&
    (value.registry.skippedTooShort === undefined || isNonNegativeInteger(value.registry.skippedTooShort)) &&
    (value.registry.filesRead === undefined || isNonNegativeInteger(value.registry.filesRead)) &&
    (value.registry.filesMissing === undefined || isNonNegativeInteger(value.registry.filesMissing)) &&
    (value.registry.filesErrored === undefined || isNonNegativeInteger(value.registry.filesErrored)) &&
    (value.registry.revision === undefined || typeof value.registry.revision === "string")
  );
}

/** @param {unknown} value */
export function isRegistryReloadError(value) {
  return (
    isRecord(value) &&
    value.ok === false &&
    value.service === "ficta" &&
    (value.status === "forbidden" || value.status === "unsupported") &&
    typeof value.message === "string"
  );
}

/** @param {unknown} value */
export function isManagedRegistryFile(value) {
  return (
    isRecord(value) &&
    value.schema === FICTA_MANAGED_REGISTRY_SCHEMA &&
    isRegistryRevision(value.revision) &&
    typeof value.generatedBy === "string" &&
    value.generatedBy.length > 0 &&
    typeof value.generatedAt === "string" &&
    value.generatedAt.length > 0 &&
    Array.isArray(value.entries) &&
    value.entries.every(isManagedRegistryEntry)
  );
}

/** @param {unknown} value */
function isManagedRegistryEntry(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    (value.scope === undefined || typeof value.scope === "string") &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    isStringArray(value.aliases) &&
    (value.kind === "secret" || value.kind === "pii" || value.kind === "custom")
  );
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
    normalizePiiBackends(value.piiBackends) !== undefined &&
    typeof value.piiFailClosed === "boolean" &&
    typeof value.piiPresidioUrl === "string" &&
    typeof value.piiOpenmedUrl === "string" &&
    typeof value.secretShapesEnabled === "boolean" &&
    (value.surrogateStyle === "opaque" || value.surrogateStyle === "typed") &&
    isRestoreIntoToolsPolicy(value.restoreIntoTools) &&
    typeof value.allowCustomUpstream === "boolean"
  );
}

/** @param {unknown} value */
export function isPiiBackendName(value) {
  return typeof value === "string" && PII_BACKEND_NAME_SET.has(value);
}

/** @param {unknown} value */
export function normalizePiiBackends(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const entry of value) {
    if (!isPiiBackendName(entry)) return undefined;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.length > 0 ? out : ["regex"];
}

/** @param {unknown} value */
export function isRestoreIntoToolsPolicy(value) {
  return typeof value === "string" && RESTORE_INTO_TOOLS_POLICY_SET.has(value);
}

/** @param {unknown} value */
export function isProxyLogLevel(value) {
  return typeof value === "string" && PROXY_LOG_LEVEL_SET.has(value);
}

/** @param {unknown} value */
export function normalizeRestoreIntoToolsPolicy(value) {
  if (isRestoreIntoToolsPolicy(value)) return value;
  if (value === true) return "all";
  if (value === false) return "none";
  return undefined;
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
    (value.pii.configuredBackends === undefined || isStringArray(value.pii.configuredBackends)) &&
    typeof value.pii.backend === "string" &&
    isPiiStatusState(value.pii.status) &&
    isDetectorFailureMode(value.pii.failureMode) &&
    typeof value.pii.message === "string" &&
    (value.pii.url === undefined || typeof value.pii.url === "string") &&
    (value.pii.detail === undefined || typeof value.pii.detail === "string")
  );
}

/** @param {unknown} value */
export function isProtectionPreviewOk(value) {
  if (!isRecord(value) || value.ok !== true || value.service !== "ficta") return false;
  return (
    typeof value.ticket === "string" &&
    value.ticket.length > 0 &&
    typeof value.textSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.textSha256) &&
    typeof value.redactedText === "string" &&
    Array.isArray(value.findings) &&
    value.findings.every(isProtectionPreviewFinding)
  );
}

/** @param {unknown} value */
function isProtectionPreviewFinding(value) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    value.start >= 0 &&
    value.end > value.start &&
    typeof value.surrogate === "string" &&
    (value.origin === "registry" || value.origin === "detected" || value.origin === "user") &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    (value.plugin === undefined || typeof value.plugin === "string") &&
    (value.kind === undefined || value.kind === "secret" || value.kind === "pii" || value.kind === "custom") &&
    (value.confidence === undefined ||
      value.confidence === "exact" ||
      value.confidence === "high" ||
      value.confidence === "probabilistic")
  );
}

/** @param {unknown} value */
export function isProtectionStatsOk(value) {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  return isStatsSnapshot(value.stats);
}

/** @param {unknown} value */
function isProtectionActivity(value) {
  return isRecord(value) && typeof value.restoredValues === "number" && typeof value.withheldFromTools === "number";
}

/** @param {unknown} value */
function isStatsSnapshot(value) {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.path === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isTotals(value.totals) &&
    isBucketArray(value.byModel) &&
    isBucketArray(value.bySurface) &&
    isBucketArray(value.byWire) &&
    isLabelBucketArray(value.byLabel) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent)
  );
}

/** @param {unknown} value */
function isTotals(value) {
  return (
    isRecord(value) &&
    typeof value.events === "number" &&
    typeof value.affectedRequests === "number" &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blockedRequests === "number" &&
    typeof value.keptOutOfModelValues === "number" &&
    typeof value.restoredValues === "number" &&
    typeof value.withheldFromToolsValues === "number"
  );
}

/** @param {unknown} value */
function isBucketArray(value) {
  return Array.isArray(value) && value.every(isBucket);
}

/** @param {unknown} value */
function isBucket(value) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.requests === "number" &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blockedRequests === "number" &&
    typeof value.keptOutOfModelValues === "number"
  );
}

/** @param {unknown} value */
function isLabelBucketArray(value) {
  return Array.isArray(value) && value.every(isLabelBucket);
}

/** @param {unknown} value */
function isLabelBucket(value) {
  return (
    isBucket(value) &&
    typeof value.source === "string" &&
    (value.plugin === undefined || typeof value.plugin === "string") &&
    (value.kind === undefined || isHitKind(value.kind)) &&
    (value.confidence === undefined || isHitConfidence(value.confidence))
  );
}

/** @param {unknown} value */
function isEvent(value) {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.at === "string" &&
    (value.requestId === undefined || typeof value.requestId === "number") &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    typeof value.wire === "string" &&
    (value.route === undefined || typeof value.route === "string") &&
    typeof value.model === "string" &&
    isSurface(value.surface) &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blocked === "boolean" &&
    Array.isArray(value.redactedHits) &&
    value.redactedHits.every(isHit) &&
    Array.isArray(value.survivingHits) &&
    value.survivingHits.every(isHit)
  );
}

/** @param {unknown} value */
function isHit(value) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    (value.plugin === undefined || typeof value.plugin === "string") &&
    (value.kind === undefined || isHitKind(value.kind)) &&
    (value.confidence === undefined || isHitConfidence(value.confidence))
  );
}

/** @param {unknown} value */
function isSurface(value) {
  return value === "body" || value === "query string" || value === "non-auth headers";
}

/** @param {unknown} value */
function isHitKind(value) {
  return value === "secret" || value === "pii" || value === "custom";
}

/** @param {unknown} value */
function isHitConfidence(value) {
  return value === "exact" || value === "high" || value === "probabilistic";
}

/** @param {unknown} value */
function isPiiStatusState(value) {
  return value === "off" || value === "ok" || value === "degraded" || value === "blocking";
}

/** @param {unknown} value */
function isDetectorFailureMode(value) {
  return value === "fail-open" || value === "fail-closed";
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** @param {unknown} value */
function isRegistryRevision(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
