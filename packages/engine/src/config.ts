import { noopWarnSink, type WarnSink } from "./diagnostics.js";
import type { RestoreIntoToolsPolicy } from "./env-flags.js";
import { type OpenmedConfig, openmedConfig } from "./plugins/pii/openmed-recognizer.js";
import { type PresidioConfig, presidioConfig } from "./plugins/pii/presidio-recognizer.js";
import { DEFAULT_BACKEND } from "./plugins/pii/registry.js";
import type { SurrogateStyle } from "./surrogate.js";

/**
 * Everything the redaction engine is configured by, passed to `new ProtectionEngine({ config })`.
 *
 * The engine never reads `process.env`: a host builds this object (the ficta CLI/proxy does it from
 * env + config.toml in `packages/ficta/src/engine-env.ts`) and hands it to each engine instance, so several engines
 * in one process can run with different settings. Settings are fixed for the engine's lifetime.
 */
export interface EngineConfig {
  readonly surrogate: {
    /**
     * HMAC key for surrogate tokens. Required by `ProtectionEngine` unless `allowEphemeralKey` is set,
     * in which case unset means a random key generated once per process (ephemeral).
     */
    readonly key?: string;
    /** Token shape: opaque `FICTA_<hex>` (default) or typed `FICTA_<TYPE>_<hex>`. */
    readonly style: SurrogateStyle;
  };
  readonly detection: {
    /** Global default for detector outages: block the request (true) or skip detection (false). */
    readonly failClosed: boolean;
  };
  readonly pii: {
    readonly enabled: boolean;
    /** Per-detector fail-closed override; undefined defers to `detection.failClosed`. */
    readonly failClosed?: boolean;
    /** Configured backend names (lowercase, deduped). Unknown names are reported and skipped. */
    readonly backends: readonly string[];
    readonly presidio: PresidioConfig;
    readonly openmed: OpenmedConfig;
  };
  readonly secretShapes: {
    readonly enabled: boolean;
  };
  readonly restore: {
    /** How surrogates inside tool-call arguments are restored (see {@link RestoreIntoToolsPolicy}). */
    readonly intoTools: RestoreIntoToolsPolicy;
  };
  /** Redact protected values even inside filesystem-path-like tokens (off: paths are preserved). */
  readonly redactPaths: boolean;
  readonly registry: {
    /** User-excluded env-var names (global). Entries are validated when the registry loads. */
    readonly excludeNames: readonly string[];
    /** User-excluded env-var names for the current project. */
    readonly projectExcludeNames: readonly string[];
  };
}

type Section<T> = { readonly [F in keyof T]?: T[F] };

/** A partial {@link EngineConfig}: any omitted section or field takes its default. */
export interface EngineConfigInput {
  readonly surrogate?: Section<EngineConfig["surrogate"]>;
  readonly detection?: Section<EngineConfig["detection"]>;
  readonly pii?: Section<Omit<EngineConfig["pii"], "presidio" | "openmed">> & {
    readonly presidio?: Partial<PresidioConfig>;
    readonly openmed?: Partial<OpenmedConfig>;
  };
  readonly secretShapes?: Section<EngineConfig["secretShapes"]>;
  readonly restore?: Section<EngineConfig["restore"]>;
  readonly redactPaths?: boolean;
  readonly registry?: Section<EngineConfig["registry"]>;
}

/** Defaults: PII off, secret shapes on, fail-open detection, opaque tokens with an ephemeral key. */
export function resolveEngineConfig(input: EngineConfigInput = {}): EngineConfig {
  return {
    surrogate: {
      key: input.surrogate?.key || undefined,
      style: input.surrogate?.style ?? "opaque",
    },
    detection: { failClosed: input.detection?.failClosed ?? false },
    pii: {
      enabled: input.pii?.enabled ?? false,
      failClosed: input.pii?.failClosed,
      backends: input.pii?.backends ?? [DEFAULT_BACKEND],
      presidio: { ...presidioConfig({}), ...input.pii?.presidio },
      openmed: { ...openmedConfig({}), ...input.pii?.openmed },
    },
    secretShapes: { enabled: input.secretShapes?.enabled ?? true },
    restore: { intoTools: input.restore?.intoTools ?? "detected" },
    redactPaths: input.redactPaths ?? false,
    registry: {
      excludeNames: input.registry?.excludeNames ?? [],
      projectExcludeNames: input.registry?.projectExcludeNames ?? [],
    },
  };
}

/**
 * What a plugin sees of the engine that is calling it: that engine's config and warn sink. Passed
 * in every detect context and to `discover()` / `failClosed()`, and stable for the engine's
 * lifetime, so a plugin can key per-engine state (e.g. backend outage counters) on it.
 */
export interface PluginRuntime {
  readonly config: EngineConfig;
  readonly warn: WarnSink;
}

/** A standalone runtime (no engine): defaults merged with `input`, warnings discarded unless `warn` is given. */
export function pluginRuntime(input: EngineConfigInput = {}, warn?: WarnSink): PluginRuntime {
  return { config: resolveEngineConfig(input), warn: warn ?? noopWarnSink };
}
