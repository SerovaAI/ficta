import { piiPlugin, resetPiiRecognizerStateForTests } from "../engine/plugins/pii/index.js";
import {
  collectPluginConfigs,
  collectPluginSetups,
  loadPluginRegistry as loadPluginRegistryCore,
  type PluginRegistrySnapshot,
} from "../engine/plugins/registry.js";
import { secretShapesPlugin } from "../engine/plugins/secret-shapes/index.js";
import type {
  ConfigBinding,
  ConfigSection,
  FictaPluginBase,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  RedactionPlugin,
  RegistryPolicy,
  RegistrySetupDiscoveryContext,
  RegistrySetupSource,
} from "../engine/plugins/types.js";
import { plural } from "../engine/text.js";
import type { AgentIntegration, AgentIntegrationPlugin } from "./agent-types.js";
import { builtInAgentPlugin } from "./agents.js";
import { dopplerPlugin, resetDopplerPluginCacheForTests } from "./doppler.js";
import { knownEnvPlugin, resetKnownEnvPluginCacheForTests } from "./known-env.js";
import { managedRegistryFilePlugin, resetManagedRegistryFilePluginCacheForTests } from "./managed-registry-file.js";

// Public plugin facade + product-side composition.
//
// This module is the one place allowed to bridge the engine's generic plugin machinery (registry.ts,
// the detectors, policy, types) with the product-side plugins (Doppler/known-env registry sources and
// the agent integrations). It also preserves the `@serovaai/ficta/plugins` public API — every symbol
// external plugin authors import stays resolvable here regardless of where files moved internally.

export {
  piiEnabled,
  piiFailClosed,
  piiPlugin,
  resetPiiRecognizerStateForTests,
  resolveAgentPiiEnabled,
} from "../engine/plugins/pii/index.js";
export {
  checkOpenmedHealth,
  OpenmedUnavailableError,
  openmedConfig,
} from "../engine/plugins/pii/openmed-recognizer.js";
export {
  checkPresidioHealth,
  PresidioUnavailableError,
  presidioConfig,
} from "../engine/plugins/pii/presidio-recognizer.js";
export type { PiiRecognizer } from "../engine/plugins/pii/recognizer.js";
export {
  activeBackend,
  activeBackends,
  backendHealthCheck,
  builtInBackendNames,
  DEFAULT_BACKEND,
  ENV_BACKEND,
  ENV_BACKENDS,
  selectedBackendName,
  selectedBackendNames,
} from "../engine/plugins/pii/registry.js";
export type { UserExclusionParse } from "../engine/plugins/policy.js";
export {
  buildRegistryPolicy,
  parseUserExclusionRule,
  protectedValueExcludedBy,
  USER_EXCLUSION_PLUGIN,
  USER_EXCLUSION_RULE_ID,
} from "../engine/plugins/policy.js";
export { type PluginRegistrySnapshot, validatePluginBoundaries } from "../engine/plugins/registry.js";
export {
  detectSecretShapes,
  resolveAgentSecretShapesEnabled,
  secretShapesEnabled,
  secretShapesPlugin,
} from "../engine/plugins/secret-shapes/index.js";
export type {
  ConfigBinding,
  ConfigBindingKind,
  ConfigSection,
  DetectorPlugin,
  DetectTextContext,
  EffectiveRegistryExclusionRule,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  ProtectedValueKind,
  ProtectionConfidence,
  RedactionPlugin,
  RegistryExclusionKind,
  RegistryExclusionRule,
  RegistryPluginConfig,
  RegistryPluginSetup,
  RegistryPolicy,
  RegistryPolicyContribution,
  RegistrySetupDiscoveryContext,
  RegistrySetupPromptContext,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "../engine/plugins/types.js";
export type {
  AgentBypassContext,
  AgentIntegration,
  AgentIntegrationPlugin,
  AgentLaunchContext,
  AgentLaunchPlan,
} from "./agent-types.js";
// --- Re-exports: the public plugin API surface (kept stable across the engine/product split). ---
export {
  claudeAgent,
  codexAgent,
  codexPersistedFictaCleanupOverrides,
  piAgent,
  piModelsConfig,
} from "./agents.js";
export { dopplerPlugin } from "./doppler.js";
export {
  managedRegistryFilePlugin,
  managedRegistryLoadCounts,
  resetManagedRegistryFilePluginCache,
} from "./managed-registry-file.js";

/**
 * The redaction plugins ficta ships and enforces by default: exact-value registry sources
 * (Doppler, known-env) plus the built-in detectors. This is the set handed to `ProtectionEngine`.
 */
export const defaultRedactionPlugins: readonly RedactionPlugin[] = [
  dopplerPlugin,
  knownEnvPlugin,
  managedRegistryFilePlugin,
  secretShapesPlugin,
  piiPlugin,
];

/** A ficta plugin: a redaction plugin (engine-processed) or an agent integration (CLI-only). */
export type FictaPlugin = RedactionPlugin | AgentIntegrationPlugin;

/** The full built-in plugin set: the redaction plugins plus the agent integrations (CLI launch). */
export const defaultPlugins: readonly FictaPlugin[] = [...defaultRedactionPlugins, builtInAgentPlugin];

/**
 * Plugins core vouches for. Only these may contribute *enforced* registry exclusions (un-protection).
 * Identity-based so a fixture/external plugin cannot grant itself trust by name. Only redaction
 * plugins declare exclusions (Doppler/known-env), so the agent plugin need not be included.
 */
const TRUSTED_BUILTINS: ReadonlySet<FictaPluginBase> = new Set(defaultRedactionPlugins);

/** Keep only the redaction plugins (drop agent integrations, which the engine machinery ignores). */
function redactionOnly(plugins: readonly FictaPlugin[]): RedactionPlugin[] {
  return plugins.filter((plugin): plugin is RedactionPlugin => plugin.kind !== "agent-integration");
}

export function pluginConfigBindings(plugins: readonly FictaPlugin[] = defaultRedactionPlugins): ConfigBinding[] {
  return collectPluginConfigs(redactionOnly(plugins)).flatMap((config) => [...config.bindings]);
}

export function pluginConfigSections(plugins: readonly FictaPlugin[] = defaultRedactionPlugins): ConfigSection[] {
  return collectPluginConfigs(redactionOnly(plugins)).flatMap((config) => [...config.sections]);
}

export function pluginEnvDefaults(plugins: readonly FictaPlugin[] = defaultRedactionPlugins): Record<string, string> {
  const out: Record<string, string> = {};
  for (const config of collectPluginConfigs(redactionOnly(plugins))) Object.assign(out, config.envDefaults);
  return out;
}

export function registrySetupDefaults(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultRedactionPlugins,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setup of collectPluginSetups(redactionOnly(plugins)))
    Object.assign(out, setup.registryDefaults?.(ctx) ?? {});
  return out;
}

export function registrySetupSources(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultRedactionPlugins,
): RegistrySetupSource[] {
  return collectPluginSetups(redactionOnly(plugins)).flatMap((setup) => [...setup.registrySources(ctx)]);
}

/**
 * Load exact registry values + build the effective registry policy for the built-in (or a supplied)
 * plugin set, enforcing only the trusted built-ins' exclusions. Agent integrations are ignored.
 */
export function loadPluginRegistry(plugins: readonly FictaPlugin[] = defaultRedactionPlugins): PluginRegistrySnapshot {
  return loadPluginRegistryCore(redactionOnly(plugins), TRUSTED_BUILTINS);
}

export function loadRegistryValues(plugins: readonly FictaPlugin[] = defaultRedactionPlugins): ProtectedValue[] {
  return loadPluginRegistry(plugins).values;
}

export function agentIntegrations(plugins: readonly FictaPlugin[] = defaultPlugins): AgentIntegration[] {
  return plugins.flatMap((plugin) => (plugin.kind === "agent-integration" ? [...plugin.agents] : []));
}

export function agentCommands(plugins: readonly FictaPlugin[] = defaultPlugins): string[] {
  return agentIntegrations(plugins).map((agent) => agent.command);
}

export function findAgentIntegration(
  command: string,
  plugins: readonly FictaPlugin[] = defaultPlugins,
): AgentIntegration | undefined {
  return agentIntegrations(plugins).find((agent) => agent.command === command);
}

export function resetPluginCachesForTests(): void {
  resetDopplerPluginCacheForTests();
  resetKnownEnvPluginCacheForTests();
  resetManagedRegistryFilePluginCacheForTests();
  resetPiiRecognizerStateForTests();
}

/**
 * Resolve a discovery to the `ProtectedValue.source` key its values carry, so per-source exclusion
 * counts (keyed by source) can be attributed back to a discovery line. The id/source naming is not
 * uniform across built-ins (Doppler's id is `doppler-cli/secrets-download` but its source is
 * `doppler`), so this small lookup is the single place that bridges the two.
 */
export function discoverySourceKey(discovery: PluginDiscovery): string | undefined {
  if (discovery.id.endsWith("/process-env")) return "process-env";
  if (discovery.id.endsWith("/env-file")) return "env-file";
  if (discovery.plugin === "managed-registry-file") return "managed-registry-file";
  if (discovery.plugin === "doppler-cli") return "doppler";
  return undefined;
}

/** Safe one-line summaries of registry-policy exclusions, for verbose reports. */
export function registryPolicyLines(
  policy: RegistryPolicy,
  indent = "  ",
  opts: { enforcedOnly?: boolean } = {},
): string[] {
  const rules = opts.enforcedOnly ? policy.exclusions.filter((rule) => rule.trusted) : policy.exclusions;
  if (rules.length === 0) return [];
  const out: string[] = [];
  for (const rule of rules) {
    const state = rule.trusted ? "enforced" : "declared, not enforced (untrusted plugin)";
    out.push(
      `${indent}${rule.trusted ? "✓" : "!"} ${rule.plugin}: ${rule.names.join(", ")} — ${rule.reason} [${state}]`,
    );
  }
  return out;
}

export function registryDiscoveryLines(
  discoveries: readonly PluginDiscovery[],
  indent = "  ",
  excludedBySource: Record<string, number> = {},
): string[] {
  if (discoveries.length === 0) return [`${indent}- no registry sources reported`];

  const out: string[] = [];
  for (const d of discoveries) {
    const count = d.valueCount === undefined ? "" : ` (${d.valueCount} ${plural(d.valueCount, "value")})`;
    const excluded = excludedBySource[discoverySourceKey(d) ?? ""] ?? 0;
    const excludedNote = excluded > 0 ? ` (${excluded} excluded by policy)` : "";
    const message = d.message ? ` — ${d.message}` : "";
    out.push(`${indent}${statusIcon(d.status)} ${d.label}${count}${excludedNote}${message}`);
    for (const detail of d.details?.slice(0, 6) ?? []) out.push(`${indent}    ${detail}`);
    if ((d.details?.length ?? 0) > 6) out.push(`${indent}    … ${(d.details?.length ?? 0) - 6} more`);
  }
  return out;
}

function statusIcon(status: PluginDiscoveryStatus): string {
  switch (status) {
    case "loaded":
      return "✓";
    case "active":
      return "✓";
    case "available":
      return "!";
    case "error":
      return "✗";
    case "disabled":
    case "not_found":
      return "-";
  }
}
