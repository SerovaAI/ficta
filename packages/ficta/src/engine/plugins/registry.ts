import { isRecord } from "../json.js";
import {
  literalProtectionRecords,
  type ProtectionRecord,
  type StructuredRegistrySourceCapabilities,
} from "../protection.js";
import { piiPlugin } from "./pii/index.js";
import {
  buildRegistryPolicy,
  parseUserExclusionRule,
  protectedValueExcludedBy,
  USER_EXCLUSION_PLUGIN,
  validateRegistryPolicy,
} from "./policy.js";
import { secretShapesPlugin } from "./secret-shapes/index.js";
import type {
  EffectiveRegistryExclusionRule,
  FictaPluginBase,
  PluginDiscovery,
  ProtectedValue,
  RedactionPlugin,
  RegistryPluginConfig,
  RegistryPluginSetup,
  RegistryPolicy,
} from "./types.js";

// Engine-side plugin registry machinery: validate plugin boundaries, load exact registry values,
// and build the effective registry policy. This is the generic core that `ProtectionEngine` depends
// on; product-side plugin composition (the built-in default set, Doppler/known-env registry sources,
// agent integrations, and the caller-facing defaults) lives in `index.ts`. Nothing here imports a
// product module — the engine stays free of the CLI, config, logger, and agent-launch layers.

/**
 * The redaction plugins the engine ships by default: request-time detectors only. Exact-value
 * registry sources (Doppler, known-env) are product-side and composed into the default set in
 * `index.ts` — so a bare engine constructed without plugins detects but loads no registry values.
 */
export const defaultDetectors: readonly RedactionPlugin[] = [secretShapesPlugin, piiPlugin];

export interface PluginRegistrySnapshot {
  values: ProtectedValue[];
  /** Logical records corresponding to the flattened exact values. */
  records: ProtectionRecord[];
  pluginNames: string[];
  discoveries: PluginDiscovery[];
  registryPolicy: RegistryPolicy;
  /** Count of launch-time candidates dropped by an enforced (trusted) exclusion. */
  policyExcluded: number;
  /** Excluded counts keyed by the candidate's `source` (e.g. "process-env"), for per-source reporting. */
  policyExcludedBySource: Record<string, number>;
  /** Safe metadata for each dropped candidate — names/sources/rule only, never values (used by `ficta review`). */
  policyExcludedValues: Array<{ name: string; source: string; plugin: string; rule: EffectiveRegistryExclusionRule }>;
}

export function validatePluginBoundaries(plugins: readonly FictaPluginBase[]): void {
  for (const rawPlugin of plugins as unknown as readonly Record<string, unknown>[]) {
    const name = typeof rawPlugin.name === "string" ? rawPlugin.name : "<unnamed>";
    validateRegistryPolicy(name, rawPlugin.registryPolicy);

    // detectBodyLeaves lives on the shared plugin base — shape-check it for every kind when
    // declared, so a malformed hook fails at load time instead of as a per-request detector outage.
    if ("detectBodyLeaves" in rawPlugin && typeof rawPlugin.detectBodyLeaves !== "function") {
      throw new Error(`ficta plugin ${name} detectBodyLeaves must be a function when declared`);
    }

    // loadValues is the registry-source-defining capability; no other kind may declare it.
    if (rawPlugin.kind !== "registry-source" && "loadValues" in rawPlugin) {
      throw new Error(`ficta plugin ${name} declares registry-source hooks but is not kind="registry-source"`);
    }

    if (rawPlugin.kind === "detector") {
      if (typeof rawPlugin.detectText !== "function") {
        throw new Error(`detector plugin ${name} must implement detectText()`);
      }
      // config/setup/discover are optional for a detector — validate shape only when declared.
      if ("config" in rawPlugin) validatePluginConfigShape(name, rawPlugin.config);
      if (
        "setup" in rawPlugin &&
        (!isRecord(rawPlugin.setup) || typeof rawPlugin.setup.registrySources !== "function")
      ) {
        throw new Error(`detector plugin ${name} must define setup.registrySources() when it declares setup`);
      }
      if ("discover" in rawPlugin && typeof rawPlugin.discover !== "function") {
        throw new Error(`detector plugin ${name} discover must be a function`);
      }
      continue;
    }

    if (rawPlugin.kind === "agent-integration") {
      // Agent integrations carry only `agents`; config/setup/discover belong to other kinds. Agent
      // plugins are never passed to the engine, but this branch stays so the generic validator (also
      // used by product-side composition) accepts the full plugin set.
      if ("config" in rawPlugin || "setup" in rawPlugin || "discover" in rawPlugin) {
        throw new Error(`ficta plugin ${name} declares registry-source hooks but is not kind="registry-source"`);
      }
      continue;
    }

    if (rawPlugin.kind !== "registry-source") {
      throw new Error(`ficta plugin ${name} has unknown kind ${String(rawPlugin.kind)}`);
    }

    if (typeof rawPlugin.loadValues !== "function") {
      throw new Error(`registry-source plugin ${name} must implement loadValues()`);
    }
    if (typeof rawPlugin.discover !== "function") {
      throw new Error(`registry-source plugin ${name} must implement discover()`);
    }
    validatePluginConfigShape(name, rawPlugin.config);
    if (!isRecord(rawPlugin.setup) || typeof rawPlugin.setup.registrySources !== "function") {
      throw new Error(`registry-source plugin ${name} must define setup.registrySources()`);
    }
  }
}

/** Shared shape check for a plugin's `config` metadata (registry-source required, detector optional). */
function validatePluginConfigShape(name: string, config: unknown): void {
  if (!isRecord(config)) {
    throw new Error(`plugin ${name} must define config metadata`);
  }
  if (!Array.isArray(config.bindings)) {
    throw new Error(`plugin ${name} config.bindings must be an array`);
  }
  if (!Array.isArray(config.sections)) {
    throw new Error(`plugin ${name} config.sections must be an array`);
  }
  if (!isRecord(config.envDefaults)) {
    throw new Error(`plugin ${name} config.envDefaults must be an object`);
  }
}

/** Config metadata declared by any redaction plugin kind (registry-source always; detector optionally). */
export function collectPluginConfigs(plugins: readonly RedactionPlugin[]): RegistryPluginConfig[] {
  validatePluginBoundaries(plugins);
  return plugins.map((plugin) => plugin.config).filter((config): config is RegistryPluginConfig => isRecord(config));
}

/** Setup metadata declared by any redaction plugin kind (registry-source always; detector optionally). */
export function collectPluginSetups(plugins: readonly RedactionPlugin[]): RegistryPluginSetup[] {
  validatePluginBoundaries(plugins);
  return plugins.map((plugin) => plugin.setup).filter((setup): setup is RegistryPluginSetup => isRecord(setup));
}

/**
 * Load exact registry values + build the effective policy for a plugin set. `trusted` is the set of
 * plugins core vouches for (the built-ins) — only their registry exclusions are enforced; any other
 * plugin's exclusions are recorded but not honored (the un-protection fence). Identity-based so a
 * fixture/external plugin cannot self-grant trust by name.
 */
export function loadPluginRegistry(
  plugins: readonly RedactionPlugin[],
  trusted: ReadonlySet<FictaPluginBase>,
): PluginRegistrySnapshot {
  validatePluginBoundaries(plugins);

  // The user's own exclusion list is a trusted rule (see parseUserExclusionRule); prepend it so an
  // overlapping name is attributed to the user rather than a plugin. It flows through the returned
  // registryPolicy to both enforcement seams (load filter here + request-time admit() in engine.ts).
  const userExclusion = parseUserExclusionRule(process.env.FICTA_REGISTRY_EXCLUDE_NAMES);
  const pluginPolicy = buildRegistryPolicy(plugins, trusted);
  const registryPolicy: RegistryPolicy = userExclusion.rule
    ? { exclusions: [userExclusion.rule, ...pluginPolicy.exclusions] }
    : pluginPolicy;
  const values: ProtectedValue[] = [];
  const records: ProtectionRecord[] = [];
  const pluginNames: string[] = [];
  const discoveries: PluginDiscovery[] = [];
  let policyExcluded = 0;
  const policyExcludedBySource: Record<string, number> = {};
  const policyExcludedValues: PluginRegistrySnapshot["policyExcludedValues"] = [];
  const diagnosedExcludedNames = new Set<string>();

  if (userExclusion.invalidNames.length > 0) {
    // status "available" renders as a note without tripping strict-mode error gates (which key off "error").
    discoveries.push({
      id: "user-config/exclude-names",
      plugin: USER_EXCLUSION_PLUGIN,
      label: "registry.exclude_names",
      status: "available",
      message: `ignoring invalid name(s): ${userExclusion.invalidNames.join(", ")}`,
    });
  }

  for (const plugin of plugins) {
    pluginNames.push(plugin.name);

    if (plugin.kind !== "registry-source") {
      // A non-registry plugin (e.g. a config-driven detector) contributes no exact values at load
      // time, but may still report a discovery/status line for the startup banner.
      if (plugin.discover) collectDiscovery(plugin.name, plugin.discover, discoveries);
      continue;
    }

    const structured = plugin as typeof plugin & Partial<StructuredRegistrySourceCapabilities>;
    try {
      const loaded = plugin.loadValues();
      const admittedValues: ProtectedValue[] = [];
      for (const value of loaded) {
        const candidate = { ...value, plugin: value.plugin ?? plugin.name };
        const excludedBy = protectedValueExcludedBy(candidate, registryPolicy);
        if (excludedBy) {
          recordPolicyExclusion(candidate, excludedBy, {
            diagnosedExcludedNames,
            policyExcludedBySource,
            policyExcludedValues,
            increment: () => policyExcluded++,
          });
          continue;
        }
        values.push(candidate);
        admittedValues.push(candidate);
      }
      const loadedRecords =
        structured.loadProtectionRecords?.() ?? literalProtectionRecords(admittedValues, "registry");
      for (const record of loadedRecords) {
        const meta = { ...record.meta, plugin: record.meta.plugin ?? plugin.name };
        const excludedBy = protectedValueExcludedBy(meta, registryPolicy);
        if (excludedBy) {
          recordPolicyExclusion(meta, excludedBy, {
            diagnosedExcludedNames,
            policyExcludedBySource,
            policyExcludedValues,
            increment: () => policyExcluded++,
          });
          continue;
        }
        records.push({ ...record, meta } as ProtectionRecord);
      }
    } catch (error) {
      if (structured.fatalLoadErrors) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`ficta registry source ${plugin.name} contains invalid data${detail}`, { cause: error });
      }
      discoveries.push({
        id: `${plugin.name}/load`,
        plugin: plugin.name,
        label: plugin.name,
        status: "error",
        message: "plugin threw while loading values",
      });
      continue;
    }

    collectDiscovery(plugin.name, plugin.discover, discoveries);
  }

  return {
    values,
    records,
    pluginNames,
    discoveries,
    registryPolicy,
    policyExcluded,
    policyExcludedBySource,
    policyExcludedValues,
  };
}

function recordPolicyExclusion(
  value: ProtectedValue,
  rule: EffectiveRegistryExclusionRule,
  diagnostics: {
    diagnosedExcludedNames: Set<string>;
    policyExcludedBySource: Record<string, number>;
    policyExcludedValues: PluginRegistrySnapshot["policyExcludedValues"];
    increment(): void;
  },
): void {
  const plugin = value.plugin ?? "unknown";
  if (diagnostics.diagnosedExcludedNames.has(value.name)) return;
  diagnostics.diagnosedExcludedNames.add(value.name);
  diagnostics.increment();
  diagnostics.policyExcludedBySource[value.source] = (diagnostics.policyExcludedBySource[value.source] ?? 0) + 1;
  diagnostics.policyExcludedValues.push({ name: value.name, source: value.source, plugin, rule });
}

/** Run a plugin's discover() and append its lines, turning a throw into a safe error discovery. */
function collectDiscovery(
  name: string,
  discover: () => readonly PluginDiscovery[],
  discoveries: PluginDiscovery[],
): void {
  try {
    discoveries.push(...discover());
  } catch {
    discoveries.push({
      id: `${name}/discover`,
      plugin: name,
      label: name,
      status: "error",
      message: "plugin threw while discovering sources",
    });
  }
}
