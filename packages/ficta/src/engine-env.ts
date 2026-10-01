// The env adapter for the redaction engine.
//
// The engine (`src/engine/`) never reads `process.env` — `scripts/check-engine-boundary.mjs` enforces
// that. Its settings arrive as an `EngineConfig` passed to each `ProtectionEngine`. This module is
// the one place ficta turns its runtime environment (env vars, with config.toml and built-in
// defaults already merged in by `loadUserConfig` / `applyRuntimeEnvDefaults`) into that config, plus
// thin `process.env`-defaulting wrappers for the env-parsing helpers the CLI, doctor and the public
// `@serovaai/ficta/plugins` API call without an explicit env.
//
// It lives outside `src/engine/` on purpose: env is a host concern. When the engine ships as its own
// package, this file stays with the CLI.

import { type EngineConfig, type PluginRuntime, pluginRuntime, resolveEngineConfig } from "./engine/config.js";
import { globalDetectionFailClosed } from "./engine/detection-policy.js";
import type { WarnSink } from "./engine/diagnostics.js";
import { type EnvSource, envFlag, restoreIntoToolsPolicy } from "./engine/env-flags.js";
import { piiEnabled as parsePiiEnabled, piiFailClosed as parsePiiFailClosed } from "./engine/plugins/pii/index.js";
import {
  checkOpenmedHealth as checkOpenmedHealthFor,
  type OpenmedConfig,
  openmedConfig as parseOpenmedConfig,
} from "./engine/plugins/pii/openmed-recognizer.js";
import {
  checkPresidioHealth as checkPresidioHealthFor,
  type PresidioConfig,
  presidioConfig as parsePresidioConfig,
} from "./engine/plugins/pii/presidio-recognizer.js";
import {
  type BackendSelection,
  type BackendSetSelection,
  activeBackend as parseActiveBackend,
  activeBackends as parseActiveBackends,
  selectedBackendName as parseSelectedBackendName,
  selectedBackendNames as parseSelectedBackendNames,
} from "./engine/plugins/pii/registry.js";
import { secretShapesEnabled as parseSecretShapesEnabled } from "./engine/plugins/secret-shapes/index.js";
import { surrogateStyle as parseSurrogateStyle, type SurrogateStyle } from "./engine/surrogate.js";
import type { VaultPolicy } from "./engine/vault.js";

/**
 * Build an engine config from env-style settings (default: this process's environment). Read once,
 * when called: an engine built from the result keeps those settings for its lifetime, so the proxy
 * resolves the environment fully (config.toml, agent-launch overrides, key file) before calling this.
 */
export function engineConfigFromEnv(env: EnvSource = process.env): EngineConfig {
  return resolveEngineConfig({
    surrogate: { key: env.FICTA_SURROGATE_KEY || undefined, style: parseSurrogateStyle(env) },
    detection: { failClosed: globalDetectionFailClosed(env) },
    pii: {
      enabled: parsePiiEnabled(env),
      failClosed: parsePiiFailClosed(env),
      backends: parseSelectedBackendNames(env),
      presidio: parsePresidioConfig(env),
      openmed: parseOpenmedConfig(env),
    },
    secretShapes: { enabled: parseSecretShapesEnabled(env) },
    restore: { intoTools: restoreIntoToolsPolicy(env.FICTA_RESTORE_INTO_TOOLS) },
    redactPaths: envFlag(env.FICTA_REDACT_PATHS),
    registry: {
      excludeNames: commaList(env.FICTA_REGISTRY_EXCLUDE_NAMES),
      projectExcludeNames: commaList(env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES),
    },
  });
}

/** The vault restore/redaction policy from env-style settings (for vaults built outside an engine). */
export function vaultPolicyFromEnv(env: EnvSource = process.env): VaultPolicy {
  const { restore, redactPaths } = engineConfigFromEnv(env);
  return { restoreIntoTools: restore.intoTools, redactPaths };
}

/** A plugin runtime from env-style settings, for plugin calls made outside an engine (doctor, review). */
export function pluginRuntimeFromEnv(env: EnvSource = process.env, warn?: WarnSink): PluginRuntime {
  return pluginRuntime(engineConfigFromEnv(env), warn);
}

// Raw entries; the registry trims and validates them (and reports invalid names).
function commaList(raw: string | undefined): string[] {
  return raw ? raw.split(",") : [];
}

// --- env-parsing helpers, defaulting to this process's environment -------------------------------

export function piiEnabled(env: EnvSource = process.env): boolean {
  return parsePiiEnabled(env);
}

export function piiFailClosed(env: EnvSource = process.env): boolean | undefined {
  return parsePiiFailClosed(env);
}

/** The global detector fail-closed default (`FICTA_FAIL_CLOSED_DETECTION`). */
export function detectionFailClosed(env: EnvSource = process.env): boolean {
  return globalDetectionFailClosed(env);
}

export function secretShapesEnabled(env: EnvSource = process.env): boolean {
  return parseSecretShapesEnabled(env);
}

export function surrogateStyle(env: EnvSource = process.env): SurrogateStyle {
  return parseSurrogateStyle(env);
}

export function presidioConfig(env: EnvSource = process.env): PresidioConfig {
  return parsePresidioConfig(env);
}

export function openmedConfig(env: EnvSource = process.env): OpenmedConfig {
  return parseOpenmedConfig(env);
}

export function checkPresidioHealth(env: EnvSource = process.env): ReturnType<typeof checkPresidioHealthFor> {
  return checkPresidioHealthFor(env);
}

export function checkOpenmedHealth(env: EnvSource = process.env): ReturnType<typeof checkOpenmedHealthFor> {
  return checkOpenmedHealthFor(env);
}

export function selectedBackendName(env: EnvSource = process.env): string {
  return parseSelectedBackendName(env);
}

export function selectedBackendNames(env: EnvSource = process.env): string[] {
  return parseSelectedBackendNames(env);
}

export function activeBackend(env: EnvSource = process.env): BackendSelection {
  return parseActiveBackend(env);
}

export function activeBackends(env: EnvSource = process.env): BackendSetSelection {
  return parseActiveBackends(env);
}
