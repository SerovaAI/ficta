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
    /**
     * Category precedence for one value claimed under several categories (normalized names, highest
     * first). When detectors disagree about the same value (a 13-digit national ID that also passes
     * the card checksum, say), the category listed earlier wins, whatever order the detectors ran or
     * returned in. Unlisted categories rank after every listed one and keep the detector's own
     * tie-breaks. A destroy category still wins over a surrogate one (see `dispositions`).
     * Empty (the default): no category outranks another.
     */
    readonly entityPriority: readonly string[];
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
  /** What happens to a detected value once it is found (default: every detection gets a surrogate). */
  readonly dispositions: {
    readonly destroy: DestroyDisposition;
  };
}

/**
 * Detection categories whose values are irreversibly replaced by a fixed marker instead of a
 * reversible surrogate. A category is the detector's `ProtectedValue.name` (lowercase, hyphenated:
 * `credit-card`, `email`, `person`, `secret-assignment`, `password-label`, ...). Destroyed values are
 * never stored in the vault and can never be restored. Registered (exact-match) values are never
 * destroyed: they keep their surrogate and fail-closed leak check.
 */
export interface DestroyDisposition {
  /**
   * Every detector finding is destroyed, whatever its category (input `categories: "*"`), so a
   * category a detector reports later can never become restorable. Registered values keep theirs.
   */
  readonly all: boolean;
  /** Normalized category names (lowercase, `_` → `-`, deduped). Empty and not `all`: nothing is destroyed. */
  readonly categories: readonly string[];
  /**
   * Marker text per category: every entry of `categories` has one (default `[REDACTED_<CATEGORY>]`).
   * Under `all`, only overridden categories appear here; every other category uses its default.
   */
  readonly labels: Readonly<Record<string, string>>;
}

/** Thrown by {@link resolveEngineConfig} (and so by `new ProtectionEngine`) for a malformed setting. */
export class InvalidEngineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEngineConfigError";
  }
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
  readonly dispositions?: {
    readonly destroy?: DestroyDispositionInput;
  };
}

/** Input form of {@link DestroyDisposition}: categories in any case/separator, labels optional. */
export interface DestroyDispositionInput {
  /** Present on a resolved disposition; keeps config resolution idempotent across host adapters. */
  readonly all?: boolean;
  /** Category names to destroy, or `"*"` for every detector finding (registered values excepted). */
  readonly categories?: readonly string[] | "*";
  /** Marker overrides per category; several categories may share one label. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Defaults: PII off, secret shapes on, fail-open detection, opaque tokens with an ephemeral key. */
export function resolveEngineConfig(input: EngineConfigInput = {}): EngineConfig {
  return {
    surrogate: {
      key: input.surrogate?.key || undefined,
      style: input.surrogate?.style ?? "opaque",
    },
    detection: {
      failClosed: input.detection?.failClosed ?? false,
      entityPriority: resolveCategoryList(input.detection?.entityPriority, "detection.entityPriority"),
    },
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
    dispositions: { destroy: resolveDestroyDisposition(input.dispositions?.destroy) },
  };
}

/** `Credit_Card`, `CREDIT-CARD` or ` credit-card ` → `credit-card`, the form detectors emit as `name`. */
export function normalizeCategory(category: string): string {
  return category.trim().toLowerCase().replaceAll("_", "-");
}

/** `credit-card` → `[REDACTED_CREDIT_CARD]`: the default marker a destroyed value of that category becomes. */
export function defaultDestroyLabel(category: string): string {
  return `[REDACTED_${normalizeCategory(category).toUpperCase().replaceAll("-", "_").replaceAll(".", "_")}]`;
}

const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** A bracketed marker of safe characters: never surrogate-shaped and unchanged by JSON escaping. */
const LABEL_PATTERN = /^\[[A-Za-z0-9_.:-]{1,64}\]$/;

/** Normalize, validate and dedupe detection category names, keeping first-occurrence order. */
function resolveCategoryList(input: readonly string[] | undefined, setting: string): string[] {
  const categories: string[] = [];
  for (const raw of input ?? []) {
    const category = typeof raw === "string" ? normalizeCategory(raw) : "";
    if (!CATEGORY_PATTERN.test(category)) {
      throw new InvalidEngineConfigError(`${setting}: ${JSON.stringify(raw)} is not a detection category name`);
    }
    if (!categories.includes(category)) categories.push(category);
  }
  return categories;
}

function resolveDestroyDisposition(input: DestroyDispositionInput | undefined): DestroyDisposition {
  const requested = input?.categories;
  const all = input?.all === true || requested === "*" || (Array.isArray(requested) && requested.includes("*"));
  if (typeof requested === "string" && requested !== "*") {
    throw new InvalidEngineConfigError('dispositions.destroy.categories: expected a list of category names or "*"');
  }
  if (all && Array.isArray(requested) && requested.length > 0 && (requested.length !== 1 || requested[0] !== "*")) {
    throw new InvalidEngineConfigError(
      'dispositions.destroy.categories: "*" destroys every category and cannot be combined with category names',
    );
  }
  const categories = all
    ? []
    : resolveCategoryList(requested as readonly string[] | undefined, "dispositions.destroy.categories");
  const overrides = new Map<string, string>();
  for (const [raw, label] of Object.entries(input?.labels ?? {})) {
    const category = normalizeCategory(raw);
    if (all ? !CATEGORY_PATTERN.test(category) : !categories.includes(category)) {
      throw new InvalidEngineConfigError(
        `dispositions.destroy.labels: ${JSON.stringify(raw)} is not listed in dispositions.destroy.categories`,
      );
    }
    if (typeof label !== "string" || !LABEL_PATTERN.test(label) || label.toUpperCase().includes("FICTA_")) {
      throw new InvalidEngineConfigError(
        `dispositions.destroy.labels.${raw}: a label must be a bracketed marker such as [REDACTED_CARD] ` +
          "(1-64 letters, digits or _ . : - inside the brackets, and never a FICTA_ token)",
      );
    }
    overrides.set(category, label);
  }
  if (all) return { all, categories, labels: Object.fromEntries(overrides) };
  const labels: Record<string, string> = {};
  for (const category of categories) labels[category] = overrides.get(category) ?? defaultDestroyLabel(category);
  return { all, categories, labels };
}

/**
 * The marker a detector finding of `category` becomes under `destroy`, or undefined when it keeps a
 * surrogate. Under `all`, a category without an override gets its default marker, or `[REDACTED]`
 * when the category name would not make a safe one.
 */
export function destroyLabel(destroy: DestroyDisposition, category: string): string | undefined {
  const normalized = normalizeCategory(category);
  if (Object.hasOwn(destroy.labels, normalized)) return destroy.labels[normalized];
  if (!destroy.all) return undefined;
  const label = defaultDestroyLabel(normalized);
  return LABEL_PATTERN.test(label) ? label : "[REDACTED]";
}

/** Whether `destroy` replaces anything. */
export function destroysAnything(destroy: DestroyDisposition): boolean {
  return destroy.all || destroy.categories.length > 0;
}

/** Default-shaped destroy markers (`[REDACTED]`, `[REDACTED_<CATEGORY>]`), which `all` can emit for any category. */
export const DEFAULT_DESTROY_MARKER_PATTERN = /\[REDACTED(?:_[A-Z0-9_]{1,55})?\]/g;

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
