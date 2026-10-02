// @serovaai/ficta-engine: the Ficta redaction engine as a library.
//
// Experimental (0.x). This entry point is what the ficta CLI/proxy builds on; the API may change in
// any minor release until 1.0. Construction: `new ProtectionEngine({ config })`, where the config
// carries an explicit surrogate key (see ProtectionEngineOptions.allowEphemeralKey).

export {
  type EngineConfig,
  type EngineConfigInput,
  type PluginRuntime,
  pluginRuntime,
  resolveEngineConfig,
} from "./config.js";
export { detectorFailClosed, globalDetectionFailClosed } from "./detection-policy.js";
export { noopWarnSink, type WarnFields, type WarnSink } from "./diagnostics.js";
export { MissingSurrogateKeyError, ProtectionEngine, type ProtectionEngineOptions } from "./engine.js";
export {
  envEnabled,
  envFlag,
  type EnvSource,
  parseBoolean,
  type RestoreIntoToolsPolicy,
  restoreIntoToolsPolicy,
} from "./env-flags.js";
export {
  piiEnabled,
  piiFailClosed,
  piiPlugin,
  resetPiiRecognizerStateForTests,
  resolveAgentPiiEnabled,
} from "./plugins/pii/index.js";
export {
  checkOpenmedHealth,
  type OpenmedConfig,
  openmedConfig,
  OpenmedUnavailableError,
} from "./plugins/pii/openmed-recognizer.js";
export {
  checkPresidioHealth,
  type PresidioConfig,
  presidioConfig,
  PresidioUnavailableError,
} from "./plugins/pii/presidio-recognizer.js";
export type { PiiRecognizer } from "./plugins/pii/recognizer.js";
export {
  activeBackend,
  activeBackends,
  backendHealthCheck,
  type BackendSelection,
  type BackendSetSelection,
  builtInBackendNames,
  DEFAULT_BACKEND,
  ENV_BACKEND,
  ENV_BACKENDS,
  selectedBackendName,
  selectedBackendNames,
} from "./plugins/pii/registry.js";
export {
  buildRegistryPolicy,
  parseUserExclusionRule,
  protectedValueExcludedBy,
  USER_EXCLUSION_PLUGIN,
  USER_EXCLUSION_RULE_ID,
  USER_PROJECT_EXCLUSION_RULE_ID,
  type UserExclusionParse,
  type UserExclusionScope,
} from "./plugins/policy.js";
export {
  collectPluginConfigs,
  collectPluginSetups,
  defaultDetectors,
  loadPluginRegistry,
  type PluginRegistrySnapshot,
  validatePluginBoundaries,
} from "./plugins/registry.js";
export {
  detectSecretShapeLeaves,
  detectSecretShapes,
  resolveAgentSecretShapesEnabled,
  secretShapesEnabled,
  secretShapesPlugin,
} from "./plugins/secret-shapes/index.js";
export type * from "./plugins/types.js";
export { buildPreservationInstruction, withPreservationInstruction } from "./preserve-literals.js";
export {
  type LiteralProtection,
  literalProtectionRecords,
  type ProtectionRecord,
  protectionRecordSurfaces,
  type RegisteredEntityCanonicalForm,
  type RegisteredEntityForm,
  type RegisteredEntityProtection,
  type StructuredRegistrySourceCapabilities,
} from "./protection.js";
export * from "./redaction-engine.js";
export {
  hexSurrogateStrategy,
  type SurrogateStrategy,
  type SurrogateStyle,
  surrogateStrategy,
  surrogateStyle,
  typedSurrogateStrategy,
} from "./surrogate.js";
export { plural, truncateRedactedText } from "./text.js";
export { type BodyLeaf, surrogateKeyWarning, Vault, type VaultPolicy, visitBodyLeaves } from "./vault.js";
export { type Wire, wireOf } from "./wire.js";
