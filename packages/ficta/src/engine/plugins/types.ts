export type ProtectedValueKind = "secret" | "pii" | "custom";
export type ProtectionConfidence = "exact" | "high" | "probabilistic";
export type ConfigBindingKind = "boolean" | "number" | "string" | "string-array-colon" | "string-array-comma";
// Only env-name matching today. Future kinds may add source/namespace scoping so an exclusion can be
// constrained to the declaring plugin's own domain rather than matching a name from any source.
export type RegistryExclusionKind = "env-name";

export interface ConfigBinding {
  env: string;
  path: readonly string[];
  kind: ConfigBindingKind;
}

export interface ConfigSection {
  path: readonly string[];
  keys: readonly string[];
}

export interface RegistrySetupDiscoveryContext {
  env: NodeJS.ProcessEnv;
}

export interface RegistrySetupPromptContext extends RegistrySetupDiscoveryContext {
  promptSelect<T extends string>(
    message: string,
    options: Array<{ value: T; label: string }>,
    initialValue: T,
  ): Promise<T>;
  promptText(message: string, initialValue: string, placeholder?: string, optional?: boolean): Promise<string>;
}

export interface RegistrySetupSource {
  id: string;
  label: string;
  defaultEnabled: boolean;
  enabledValues(ctx: RegistrySetupPromptContext): Promise<Record<string, string>> | Record<string, string>;
  disabledValues(ctx: RegistrySetupDiscoveryContext): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * Safe, metadata-only exclusion rule declared by the plugin that owns a domain — it names exact
 * identifiers (for now, env var names) that are not secret material. This is an un-protection rule,
 * so core only enforces it when the declaring plugin is trusted (see RegistryPolicy).
 */
export interface RegistryExclusionRule {
  id: string;
  kind: RegistryExclusionKind;
  /** Exact safe identifiers only. For kind="env-name", env var names such as DOPPLER_CONFIG. */
  names: readonly string[];
  /** Safe explanation for diagnostics/docs. Never include protected values. */
  reason: string;
}

/** Effective rule after core attaches the declaring plugin name and whether core enforces it. */
export interface EffectiveRegistryExclusionRule extends RegistryExclusionRule {
  plugin: string;
  /** True when the declaring plugin is trusted (built-in). Untrusted rules are reported, not enforced. */
  trusted: boolean;
}

/** Optional plugin contribution to registry policy. No raw values or executable predicates. */
export interface RegistryPolicyContribution {
  exclusions?: readonly RegistryExclusionRule[];
}

/** Core-owned effective policy used to filter named registry/detector candidates before protection. */
export interface RegistryPolicy {
  exclusions: readonly EffectiveRegistryExclusionRule[];
}

export interface RegistryPluginConfig {
  /** Env/TOML bindings this registry source owns. Use [] when no persistent config is needed. */
  bindings: readonly ConfigBinding[];
  /** TOML section render order for this registry source. Use [] when no persistent config is needed. */
  sections: readonly ConfigSection[];
  /** Runtime defaults this registry source owns. Use {} when no defaults are needed. */
  envDefaults: Readonly<Record<string, string>>;
}

export interface RegistryPluginSetup {
  /** Non-source defaults written by setup for this registry plugin, e.g. process-env mode. */
  registryDefaults?(ctx: RegistrySetupDiscoveryContext): Record<string, string>;
  /** Setup-visible registry sources owned by this plugin. Use [] to make deliberate non-interactive sources explicit. */
  registrySources(ctx: RegistrySetupDiscoveryContext): readonly RegistrySetupSource[];
}

/** A concrete value ficta can reversibly surrogate. Values must never be logged. */
export interface ProtectedValueSpan {
  /** Inclusive UTF-16 offset in the exact text passed to detectText(). */
  start: number;
  /** Exclusive UTF-16 offset in the exact text passed to detectText(). */
  end: number;
}

export interface ProtectedValue {
  /** Safe label for metadata/logging, e.g. env var name. Never the value. */
  name: string;
  /** The sensitive literal. Kept in memory only. */
  value: string;
  /** Safe source label, e.g. env-file, process-env, pii-detector. */
  source: string;
  /** Plugin that produced this value. Filled by the plugin manager if omitted. */
  plugin?: string;
  kind?: ProtectedValueKind;
  confidence?: ProtectionConfidence;
  /** Request-transient detector coordinates. Never retained in engine/keyed-scope metadata. */
  spans?: readonly ProtectedValueSpan[];
}

export interface DetectTextContext {
  surface: "body" | "header";
  /** Request path, if available. */
  path?: string;
  /** Header name for surface="header". */
  header?: string;
}

/**
 * `loaded` — a registry *source* that pulled in N exact values up front (count is meaningful).
 * `active` — a *detector* that is on but pre-loads nothing; it matches each request at runtime, so it
 *   reports no value count. Distinct from `available` so an on detector reads as ✓, not a `!` warning.
 * `available` — could act but has not loaded (mildly notable for a source). `disabled`/`not_found`/`error`.
 */
export type PluginDiscoveryStatus = "loaded" | "active" | "available" | "disabled" | "not_found" | "error";

/**
 * Safe launch-time discovery metadata. This is what the CLI/banner may print.
 * It must contain counts, names, paths, or instructions only — never protected values.
 */
export interface PluginDiscovery {
  /** Stable id for the discovered source, e.g. known-env-values/env-file. */
  id: string;
  /** Plugin that owns this source. */
  plugin: string;
  /** Human label shown in startup output. */
  label: string;
  status: PluginDiscoveryStatus;
  /** Number of values loaded from this source, if known. */
  valueCount?: number;
  /** Safe one-line explanation. */
  message?: string;
  /** Optional safe details, e.g. file names + counts. */
  details?: string[];
}

/**
 * Common base for every plugin kind. Exported so the product-side agent-integration plugin
 * (see `agent-types.ts`) can extend it without the engine depending on agent-launch types.
 */
export interface FictaPluginBase {
  name: string;
  description?: string;
  /**
   * Safe metadata-only registry policy owned by this plugin's domain. Core enforces it (only for
   * trusted built-ins) wherever named candidates enter protection — registry load and request-time
   * detection alike.
   */
  registryPolicy?: RegistryPolicyContribution;
}

/**
 * Registry-source plugins own their config/setup metadata and may only report exact values plus
 * safe discovery metadata. The core vault owns replacement, fail-closed leak checks, and restore.
 */
export interface RegistrySourcePlugin extends FictaPluginBase {
  kind: "registry-source";

  /** Built-in config metadata owned by the registry plugin, not the core config writer. */
  config: RegistryPluginConfig;

  /** Built-in setup prompts/defaults owned by the registry plugin, not the core setup flow. */
  setup: RegistryPluginSetup;

  /** Safe launch-time source discovery/status, printed before the agent starts. */
  discover(): readonly PluginDiscovery[];

  /**
   * Load exact registered *candidates* at startup (strongest exact-match layer). These are not the
   * final protected set: core (loadPluginRegistry / ProtectionEngine) applies trusted registry-policy
   * exclusions and the vault dedupes, so a source's own count can exceed what actually enters
   * protection.
   */
  loadValues(): readonly ProtectedValue[];

  /** Optional detector capability can coexist, but the registry contract remains required. */
  detectText?(text: string, ctx: DetectTextContext): readonly ProtectedValue[] | Promise<readonly ProtectedValue[]>;
}

export interface DetectorPlugin extends FictaPluginBase {
  kind: "detector";
  detectText(text: string, ctx: DetectTextContext): readonly ProtectedValue[] | Promise<readonly ProtectedValue[]>;
  /**
   * Optional config bindings — an `enabled` flag and any backend settings — surfaced through the
   * shared env ↔ TOML ↔ `ficta setup` plumbing. A detector self-gates on its own flag; the core
   * never adds/removes plugins by config, and detectors never load exact registry values.
   */
  config?: RegistryPluginConfig;
  /** Optional `ficta setup` prompts/defaults for this detector's config. */
  setup?: RegistryPluginSetup;
  /** Optional startup discovery/status line (counts, names — never values). */
  discover?(): readonly PluginDiscovery[];
  /**
   * Optional per-detector fail-closed override. Return `true`/`false` to require/allow this detector's
   * outages, or `undefined` to defer to the global default (`FICTA_FAIL_CLOSED_DETECTION`). This only
   * *exposes* the user's configured policy — a detector never enforces it. When `detectText` throws a
   * {@link import("../redaction-engine.js").DetectorUnavailableError}, the core resolves this against
   * the global default and decides whether to block the request.
   */
  failClosed?(): boolean | undefined;
  /** Detectors have no exact values to load; `loadValues` stays a registry-source-only capability. */
  loadValues?: never;
}

/**
 * The plugin kinds the redaction engine processes: exact-value sources and request-time detectors.
 * Agent-integration plugins (see `agent-types.ts`) are a product concern, inert for redaction, and
 * are never passed to the engine — so they are deliberately absent from this union.
 */
export type RedactionPlugin = RegistrySourcePlugin | DetectorPlugin;
