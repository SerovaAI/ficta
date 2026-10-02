import {
  type DestroyDispositionInput,
  type EngineConfigInput,
  InvalidEngineConfigError,
  normalizeCategory,
  resolveEngineConfig,
} from "./config.js";
import type { WarnSink } from "./diagnostics.js";
import { MissingSurrogateKeyError, ProtectionEngine } from "./engine.js";
import { piiPlugin } from "./plugins/pii/index.js";
import { type OpenmedConfig, OpenmedUnavailableError } from "./plugins/pii/openmed-recognizer.js";
import { categoryOf, type PresidioConfig, PresidioUnavailableError } from "./plugins/pii/presidio-recognizer.js";
import { secretShapesPlugin } from "./plugins/secret-shapes/index.js";
import type { DetectorPlugin, ProtectedValueKind, RedactionPlugin } from "./plugins/types.js";
import { type ContentRedactionDetails, DetectorUnavailableError, type RestoreTextDetails } from "./redaction-engine.js";
import type { SurrogateStyle } from "./surrogate.js";
import { truncateRedactedText } from "./text.js";
import { type VaultEntry, type VaultStore, VaultStoreError } from "./vault-store.js";

// The library facade: a small, fail-closed surface over ProtectionEngine for in-process callers.
// Each profile is its own ProtectionEngine; all of them share one surrogate key, one token style and
// one vault store, so a value gets the same token whichever profile (or process) minted it.

/** Options for {@link createEngine}. */
export interface CreateEngineOptions {
  /**
   * HMAC key for surrogate tokens: a stable, high-entropy secret of at least 32 bytes. Required:
   * the facade never falls back to a per-process key ({@link MissingSurrogateKeyError} otherwise).
   */
  readonly surrogateKey: string;
  /** Token shape: opaque `FICTA_<hex>` (default) or typed `FICTA_<TYPE>_<hex>`. */
  readonly surrogateStyle?: SurrogateStyle;
  /**
   * Persistent store for keyed scopes' mappings (see `@serovaai/ficta-engine/sqlite`). Without one,
   * mappings live in this engine's memory only. The engine takes ownership: {@link FictaEngine.close}
   * closes it.
   */
  readonly vault?: VaultStore;
  /** Presidio analyzer sidecar. Configuring it adds the `presidio` PII backend to every PII profile. */
  readonly presidio?: Partial<Omit<PresidioConfig, "entities">>;
  /** OpenMed sidecar. Configuring it adds the `openmed` PII backend to every PII profile. */
  readonly openmed?: Partial<Omit<OpenmedConfig, "entities">>;
  readonly detection?: {
    /** Category precedence for one value claimed under several categories, highest first. */
    readonly entityPriority?: readonly string[];
  };
  /** Named redaction profiles; every call names the profile it runs. At least one is required. */
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
  /** Sink for values-free warnings (backend outages, restore-only tokens). Default: discard. */
  readonly onWarn?: WarnSink;
}

/** What one profile detects, and what happens to what it finds. */
export interface ProfileConfig {
  /** Run PII detection (the in-process regex floor plus any configured sidecar). Default true. */
  readonly pii?: boolean;
  /**
   * Keep only PII findings of these entity types (Presidio names such as `PERSON` or
   * `EMAIL_ADDRESS`; matched case-insensitively, `_` read as `-`). Sent to Presidio as its
   * `entities` allowlist and applied to every PII backend's findings, the regex floor included
   * (whose `email` findings count as `EMAIL_ADDRESS`). Omitted: every type the backends report.
   */
  readonly entities?: readonly string[];
  /** Run secret-shape detection (API keys, JWTs, labelled passwords, ...). Default true. */
  readonly secretShapes?: boolean;
  /** Categories whose values are irreversibly replaced by a marker instead of a surrogate. */
  readonly destroy?: DestroyDispositionInput;
}

/** A matched value's safe metadata. Never the value or its token. */
export interface ItemHit {
  /** Detection category (`email`, `person`, `credit-card`, ...). */
  readonly name: string;
  readonly kind?: ProtectedValueKind;
  /** `surrogate`: replaced by a token; `destroy`: replaced by an irreversible marker. */
  readonly disposition: "surrogate" | "destroy";
}

/** One redacted text and its values-free summary. */
export interface ItemResult {
  readonly text: string;
  /** Distinct values replaced (surrogated or destroyed). */
  readonly count: number;
  /** Distinct values irreversibly destroyed. */
  readonly destroyed: number;
  /** One entry per distinct replaced value (labels may repeat). */
  readonly hits: readonly ItemHit[];
}

/** A batch result: `texts[i]` is `items[i].text`. */
export interface BatchResult {
  readonly texts: readonly string[];
  readonly items: readonly ItemResult[];
}

export interface FictaRestoreOptions {
  /**
   * Replacement for every token-shaped string the vault does not map (pruned, forgotten, mangled
   * or invented). Non-empty and never containing `FICTA_`. Omit to leave unknown tokens in place.
   */
  readonly unknownToken?: string;
}

export interface TruncateOptions {
  /** `"word"`: cut at the last whitespace before the limit when there is one. */
  readonly boundary?: "word";
  /** Appended when the text was shortened; counts toward the limit. */
  readonly ellipsis?: string;
}

/** A keyed scope: reversible pseudonymisation whose tokens restore within the same scope key. */
export interface FictaScope {
  readonly key: string;
  /** Redact one text under `profile`, saving its new mappings before returning. */
  pseudonymise(text: string, profile: string): Promise<ItemResult>;
  /** Redact each text under `profile`, one at a time. All or nothing: any failure throws. */
  pseudonymiseMany(texts: readonly string[], profile: string): Promise<BatchResult>;
  /** Restore this scope's tokens to their values, counting restored and unknown tokens. */
  restore(text: string, opts?: FictaRestoreOptions): Promise<RestoreTextDetails>;
}

/** The library facade. See the package README. */
export interface FictaEngine {
  /** Profile names, in configuration order. */
  readonly profiles: readonly string[];
  /** Redact each text under `profile`, keeping nothing afterwards. All or nothing: any failure throws. */
  redactMany(texts: readonly string[], profile: string): Promise<BatchResult>;
  /** Open (or reopen) the keyed scope `key`. */
  scope(key: string): FictaScope;
  /** Shorten redacted text without cutting a token or marker in half. */
  truncate(text: string, maxLength: number, opts?: TruncateOptions): string;
  /** Wait for background vault writes, then close the vault store. Idempotent. */
  close(): Promise<void>;
}

/** Why redaction (or a restore's store lookup) could not complete. */
export type RedactionUnavailableReason =
  | "unreachable"
  | "timeout"
  | "http_error"
  | "bad_response"
  | "detector_error"
  | "store_error"
  | "internal_error";

/**
 * The facade could not redact (or restore) and returned nothing. A batch is all or nothing, so no
 * text from the call is usable. The message names the reason, the detector or backend, and the
 * failing item's index, never a value or any input text; `cause` keeps the underlying error.
 */
export class RedactionUnavailableError extends Error {
  constructor(
    readonly reason: RedactionUnavailableReason,
    readonly detector?: string,
    /** Index of the failing text in a batch call. */
    readonly item?: number,
    options?: { readonly cause?: unknown },
  ) {
    const where = [detector ? `detector ${detector}` : "", item !== undefined ? `item ${item}` : ""]
      .filter(Boolean)
      .join(", ");
    super(`redaction unavailable: ${reason}${where ? ` (${where})` : ""}`);
    this.name = "RedactionUnavailableError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A call named a profile that {@link createEngine} was not given. */
export class UnknownProfileError extends Error {
  constructor(readonly profile: string) {
    super(`unknown redaction profile ${JSON.stringify(profile)}`);
    this.name = "UnknownProfileError";
  }
}

const ENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Build the facade. Every profile is validated here: a malformed setting throws
 * {@link InvalidEngineConfigError}, a missing key {@link MissingSurrogateKeyError}.
 */
export async function createEngine(options: CreateEngineOptions): Promise<FictaEngine> {
  if (typeof options?.surrogateKey !== "string" || options.surrogateKey.length === 0) {
    throw new MissingSurrogateKeyError(
      "createEngine needs surrogateKey: a stable, high-entropy secret of at least 32 bytes",
    );
  }
  const names = Object.keys(options.profiles ?? {});
  if (names.length === 0) throw new InvalidEngineConfigError("profiles: configure at least one profile");

  const store = options.vault ?? new MemoryVaultStore();
  const backends = ["regex"];
  if (options.presidio) backends.push("presidio");
  if (options.openmed) backends.push("openmed");
  const shared = {
    surrogate: { key: options.surrogateKey, style: options.surrogateStyle ?? "opaque" },
    // The facade is always fail-closed: a detector that cannot run fails the call.
    detection: { failClosed: true, entityPriority: options.detection?.entityPriority ?? [] },
    // Library content is not an agent's file paths: redact values inside path-like tokens too.
    redactPaths: true,
  } satisfies EngineConfigInput;
  resolveEngineConfig(shared); // engine-wide settings (entityPriority) fail here, not under a profile name

  const engines = new Map<string, ProtectionEngine>();
  for (const name of names) {
    const profile = options.profiles[name] as ProfileConfig;
    if (profile === null || typeof profile !== "object") {
      throw new InvalidEngineConfigError(`profiles.${name}: expected an object`);
    }
    const entities = profileEntities(name, profile.entities);
    const pii = profile.pii ?? true;
    const plugins: RedactionPlugin[] = [];
    if (profile.secretShapes ?? true) plugins.push(secretShapesPlugin);
    if (pii) plugins.push(entities ? entityFilteredPii(entities) : piiPlugin);
    try {
      engines.set(
        name,
        new ProtectionEngine({
          plugins,
          config: {
            ...shared,
            pii: {
              enabled: pii,
              failClosed: true,
              backends,
              presidio: { ...options.presidio, entities: entities ?? [] },
              openmed: { ...options.openmed },
            },
            secretShapes: { enabled: profile.secretShapes ?? true },
            dispositions: { destroy: profile.destroy ?? {} },
          },
          onWarn: options.onWarn,
          vault: store,
        }),
      );
    } catch (err) {
      if (err instanceof InvalidEngineConfigError) {
        throw new InvalidEngineConfigError(`profiles.${name}: ${err.message}`);
      }
      throw err;
    }
  }
  // Restores run detection-free on their own engine, so any profile's tokens restore in any scope.
  const restorer = new ProtectionEngine({ plugins: [], config: shared, onWarn: options.onWarn, vault: store });
  return new Facade(engines, restorer, store);
}

function profileEntities(name: string, entities: readonly string[] | undefined): string[] | undefined {
  if (entities === undefined) return undefined;
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new InvalidEngineConfigError(`profiles.${name}.entities: list at least one entity type, or omit it`);
  }
  for (const entity of entities) {
    if (typeof entity !== "string" || !ENTITY_PATTERN.test(entity)) {
      throw new InvalidEngineConfigError(
        `profiles.${name}.entities: ${JSON.stringify(entity)} is not an entity type name`,
      );
    }
  }
  return [...entities];
}

/** Regex-floor categories that name the same thing as a Presidio entity type. */
const FLOOR_ALIASES: Readonly<Record<string, string>> = { "email-address": "email" };

/** The PII plugin, keeping only findings whose category is one of `entities`. */
function entityFilteredPii(entities: readonly string[]): DetectorPlugin {
  const allowed = new Set(entities.map((entity) => normalizeCategory(categoryOf(entity))));
  for (const [entity, floor] of Object.entries(FLOOR_ALIASES)) if (allowed.has(entity)) allowed.add(floor);
  return {
    ...piiPlugin,
    async detectText(text, ctx) {
      const values = await piiPlugin.detectText(text, ctx);
      return values.filter((value) => allowed.has(normalizeCategory(value.name)));
    },
  };
}

class Facade implements FictaEngine {
  private closed = false;

  constructor(
    private readonly engines: ReadonlyMap<string, ProtectionEngine>,
    private readonly restorer: ProtectionEngine,
    private readonly store: VaultStore,
  ) {}

  get profiles(): readonly string[] {
    return [...this.engines.keys()];
  }

  async redactMany(texts: readonly string[], profile: string): Promise<BatchResult> {
    const engine = this.engineFor(profile);
    checkTexts(texts);
    // A fresh unkeyed scope per item: nothing detected in one text carries over to the next, and
    // nothing is kept (or written to the vault) afterwards.
    return runBatch(texts, (text) => engine.beginRequest().redactContentDetailed(text));
  }

  scope(key: string): FictaScope {
    this.assertOpen();
    if (typeof key !== "string" || key.length === 0) throw new TypeError("scope key must be a non-empty string");
    return {
      key,
      pseudonymise: async (text, profile) => {
        const engine = this.engineFor(profile);
        checkTexts([text]);
        return redactItem(() => engine.beginRequest(key).redactContentDetailed(text));
      },
      pseudonymiseMany: async (texts, profile) => {
        const engine = this.engineFor(profile);
        checkTexts(texts);
        // Sequential calls on one keyed scope: each text gets its own detector call, and a value
        // found in one text keeps its token (and stays redacted) in the rest of the scope.
        return runBatch(texts, (text) => engine.beginRequest(key).redactContentDetailed(text));
      },
      restore: async (text, opts = {}) => {
        this.assertOpen();
        if (typeof text !== "string") throw new TypeError("restore expects a string");
        const scope = this.restorer.beginRequest(key);
        try {
          await scope.prepareRestore(text);
        } catch (err) {
          throw unavailable(err);
        }
        // close() may have run while prepareRestore awaited the store.
        this.assertOpen();
        return scope.restoreTextDetailed(text, { unknownToken: opts.unknownToken });
      },
    };
  }

  truncate(text: string, maxLength: number, opts: TruncateOptions = {}): string {
    return truncateRedactedText(text, maxLength, {
      wordBoundary: opts.boundary === "word",
      ellipsis: opts.ellipsis,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.engines.values(), this.restorer].map((engine) => engine.flushVault()));
    await this.store.close();
  }

  private engineFor(profile: string): ProtectionEngine {
    this.assertOpen();
    const engine = typeof profile === "string" ? this.engines.get(profile) : undefined;
    if (!engine) throw new UnknownProfileError(String(profile));
    return engine;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("this ficta engine is closed");
  }
}

function checkTexts(texts: readonly string[]): void {
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
    throw new TypeError("expected an array of strings");
  }
}

async function runBatch(
  texts: readonly string[],
  redact: (text: string) => Promise<ContentRedactionDetails>,
): Promise<BatchResult> {
  const items: ItemResult[] = [];
  for (const [index, text] of texts.entries()) items.push(await redactItem(() => redact(text), index));
  return { texts: items.map((item) => item.text), items };
}

async function redactItem(redact: () => Promise<ContentRedactionDetails>, index?: number): Promise<ItemResult> {
  let details: ContentRedactionDetails;
  try {
    details = await redact();
  } catch (err) {
    throw unavailable(err, index);
  }
  // Under fail-closed nothing is skipped, and a known value surviving its own redaction is a bug:
  // either way the text is not safe to return.
  if (details.skippedDetectors?.length) {
    throw new RedactionUnavailableError("detector_error", details.skippedDetectors.join(","), index);
  }
  if (details.leaks > 0) throw new RedactionUnavailableError("internal_error", undefined, index);
  return itemResult(details);
}

function itemResult(details: ContentRedactionDetails): ItemResult {
  return {
    text: details.text,
    count: details.count,
    destroyed: details.destroyed ?? 0,
    hits: details.hits.map((hit) => ({
      name: hit.name,
      ...(hit.kind ? { kind: hit.kind } : {}),
      disposition: hit.disposition ?? "surrogate",
    })),
  };
}

/** Map any failure inside a redaction or restore to a values-free {@link RedactionUnavailableError}. */
function unavailable(err: unknown, item?: number): RedactionUnavailableError {
  if (err instanceof RedactionUnavailableError) return err;
  const cause = { cause: err };
  if (err instanceof VaultStoreError) return new RedactionUnavailableError("store_error", undefined, item, cause);
  if (err instanceof DetectorUnavailableError) {
    const detector = err.backend ?? err.plugin;
    const backendError = err.cause;
    if (backendError instanceof PresidioUnavailableError || backendError instanceof OpenmedUnavailableError) {
      return new RedactionUnavailableError(backendError.reason, detector, item, cause);
    }
    return new RedactionUnavailableError("detector_error", detector, item, cause);
  }
  return new RedactionUnavailableError("internal_error", undefined, item, cause);
}

/**
 * The store used when the caller attaches none: keeps keyed scopes' mappings in this process's
 * memory, so every profile engine and the restore engine share them. Gone on close or exit.
 */
class MemoryVaultStore implements VaultStore {
  private readonly scopes = new Map<string, Map<string, { entry: VaultEntry; usedAt: number }>>();

  async load(scope: string): Promise<readonly VaultEntry[]> {
    return [...(this.scopes.get(scope)?.values() ?? [])].map((row) => row.entry);
  }

  async lookup(scope: string, tokens: readonly string[]): Promise<readonly VaultEntry[]> {
    const wanted = new Set(tokens);
    return (await this.load(scope)).filter((entry) => wanted.has(entry.token));
  }

  async append(scope: string, entries: readonly VaultEntry[]): Promise<void> {
    let rows = this.scopes.get(scope);
    if (!rows) this.scopes.set(scope, (rows = new Map()));
    const now = Date.now();
    for (const entry of entries) rows.set(`${entry.layer}\u0000${entry.token}`, { entry, usedAt: now });
  }

  async touch(scope: string, tokens: readonly string[], at: Date): Promise<void> {
    const wanted = new Set(tokens);
    for (const row of this.scopes.get(scope)?.values() ?? []) {
      if (wanted.has(row.entry.token)) row.usedAt = Math.max(row.usedAt, at.getTime());
    }
  }

  async prune(opts: { readonly notUsedSince: Date }): Promise<number> {
    return this.remove(
      () => true,
      (row) => row.usedAt < opts.notUsedSince.getTime(),
    );
  }

  async forget(value: string, opts: { readonly scope?: string } = {}): Promise<number> {
    return this.remove(
      (scope) => opts.scope === undefined || scope === opts.scope,
      (row) => row.entry.value === value,
    );
  }

  async close(): Promise<void> {
    this.scopes.clear();
  }

  private remove(
    inScope: (scope: string) => boolean,
    matches: (row: { entry: VaultEntry; usedAt: number }) => boolean,
  ): number {
    let removed = 0;
    for (const [scope, rows] of this.scopes) {
      if (!inScope(scope)) continue;
      for (const [key, row] of rows) {
        if (!matches(row)) continue;
        rows.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
