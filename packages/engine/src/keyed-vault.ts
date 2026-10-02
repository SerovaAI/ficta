import type { WarnSink } from "./diagnostics.js";
import type { ProtectedValue } from "./plugins/types.js";
import type { HydratedEntity, HydratedLiteral, SurrogateTable } from "./vault.js";
import {
  type VaultEntityEntry,
  type VaultEntry,
  type VaultLayer,
  type VaultLiteralEntry,
  type VaultStore,
  VaultStoreError,
} from "./vault-store.js";

/** The engine's set of in-flight background store writes (last-used updates after a restore). */
export class BackgroundVaultWrites {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly warn: WarnSink) {}

  /** Run `write` in the background; a failure is reported (values-free) and never thrown. */
  run(operation: string, write: () => Promise<void>): void {
    const promise = write()
      .catch((err: unknown) => {
        this.warn(
          { operation, error: err instanceof Error ? err.name : typeof err },
          "vault store write failed in the background",
        );
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }
}

/** The in-memory state of one keyed scope that a store persists (see `KeyedScopeState`). */
export interface KeyedScopeTables {
  readonly detected: SurrogateTable;
  readonly registryDerived: SurrogateTable;
  readonly metadata: Map<string, ProtectedValue[]>;
  readonly tokenOnly: Set<string>;
}

/**
 * Keeps one keyed scope's mapping tables in step with a {@link VaultStore}: hydrates them on first
 * use, fetches tokens minted by other processes on a restore miss, appends new or changed mappings
 * after each redaction, and records last use. Only the detected and registry-derived layers are
 * persisted: values destroyed by a destroy disposition never enter those tables, so they can never
 * reach the store, and caller-selected values are request-local by design. The swept-leaf hashes are
 * an optimisation and are not persisted (a new process re-detects once).
 */
export class KeyedScopePersistence {
  private hydration?: Promise<void>;
  /** Fingerprint of each entry as last persisted or loaded, keyed by layer + token. */
  private readonly persisted = new Map<string, string>();
  private warnedRestoreOnly = false;

  constructor(
    private readonly store: VaultStore,
    private readonly scopeKey: string,
    private readonly tables: KeyedScopeTables,
    private readonly writes: BackgroundVaultWrites,
    private readonly warn: WarnSink,
  ) {
    tables.detected.trackChanges();
    tables.registryDerived.trackChanges();
  }

  /** Load the scope's stored mappings once (or again with `refresh`). Concurrent callers share one load. */
  hydrate(refresh = false): Promise<void> {
    if (this.hydration && !refresh) return this.hydration;
    const attempt = (async () => {
      const entries = await this.call("load", () => this.store.load(this.scopeKey));
      this.apply(entries);
    })();
    this.hydration = attempt;
    attempt.catch(() => {
      if (this.hydration === attempt) this.hydration = undefined; // let the next call retry
    });
    return attempt;
  }

  /** Fetch stored mappings for tokens no in-memory layer maps (minted by another process). */
  async hydrateTokens(tokens: readonly string[]): Promise<number> {
    await this.hydrate();
    if (tokens.length === 0) return 0;
    const entries = await this.call("lookup", () => this.store.lookup(this.scopeKey, tokens));
    this.apply(entries);
    return new Set(entries.map((entry) => entry.token)).size;
  }

  /**
   * Append every mapping that changed since the last persist (plus `candidates`, values this request
   * touched), then record `emitted` tokens as used. Throws {@link VaultStoreError} if the append
   * fails; the changed values stay marked so the next request retries them.
   */
  async persist(candidates: Iterable<string>, emitted: readonly string[]): Promise<void> {
    const extra = [...candidates];
    const changedDetected = new Set([...this.tables.detected.takeChanged(), ...extra]);
    const changedRegistry = new Set([...this.tables.registryDerived.takeChanged(), ...extra]);
    const entries = [
      ...this.entriesFor("detected", this.tables.detected, changedDetected),
      ...this.entriesFor("registry", this.tables.registryDerived, changedRegistry),
    ];
    const fresh = entries.filter((entry) => this.persisted.get(entryKey(entry)) !== fingerprint(entry));
    if (fresh.length > 0) {
      try {
        await this.call("append", () => this.store.append(this.scopeKey, fresh));
      } catch (err) {
        this.tables.detected.markChanged(changedDetected);
        this.tables.registryDerived.markChanged(changedRegistry);
        throw err;
      }
      for (const entry of fresh) this.persisted.set(entryKey(entry), fingerprint(entry));
    }
    // Appending already stamped the fresh entries; record use only for previously stored tokens.
    const appended = new Set(fresh.map((entry) => entry.token));
    this.touchLater(emitted.filter((token) => !appended.has(token)));
  }

  /** Record restored tokens as used, in the background. */
  touchLater(tokens: readonly string[]): void {
    const used = this.knownTokens(tokens);
    if (used.length === 0) return;
    const at = new Date();
    this.writes.run("touch", () => this.store.touch(this.scopeKey, used, at));
  }

  private knownTokens(tokens: readonly string[]): string[] {
    return [...new Set(tokens)].filter(
      (token) => this.persisted.has(`detected\u0000${token}`) || this.persisted.has(`registry\u0000${token}`),
    );
  }

  private entriesFor(layer: VaultLayer, table: SurrogateTable, values: ReadonlySet<string>): VaultEntry[] {
    const entries: VaultEntry[] = [];
    for (const value of values) {
      const literal = table.literalMapping(value);
      if (!literal) continue;
      const meta = this.tables.metadata.get(value)?.[0];
      const entry: VaultLiteralEntry = {
        type: "literal",
        layer,
        token: literal.token,
        value,
        hint: literal.hint,
        matchForm: literal.matchForm,
        wordBounded: literal.wordBounded,
        tokenOnly: this.tables.tokenOnly.has(value),
      };
      if (meta) {
        const { value: _value, spans: _spans, ...labels } = meta;
        entries.push({ ...entry, metadata: labels });
      } else {
        entries.push(entry);
      }
      for (const mapping of table.entityMappings(value)) {
        const entity: VaultEntityEntry = {
          type: "entity",
          layer,
          token: mapping.token,
          value,
          entityId: mapping.entityId,
          entityType: mapping.entityType,
          entityTag: mapping.entityTag,
        };
        entries.push(entity);
      }
    }
    return entries;
  }

  private apply(entries: readonly VaultEntry[]): void {
    const literals: Record<VaultLayer, HydratedLiteral[]> = { detected: [], registry: [] };
    const entities: Record<VaultLayer, HydratedEntity[]> = { detected: [], registry: [] };
    for (const entry of entries) {
      this.persisted.set(entryKey(entry), fingerprint(entry));
      if (entry.type === "entity") {
        entities[entry.layer].push(entry);
        continue;
      }
      literals[entry.layer].push(entry);
      // In-memory state wins for a value this process already knows; the store fills the gaps.
      if (!this.tables.metadata.has(entry.value) && entry.metadata) {
        this.tables.metadata.set(entry.value, [{ ...entry.metadata, value: entry.value }]);
        if (entry.tokenOnly) this.tables.tokenOnly.add(entry.value);
      }
    }
    const restoreOnly =
      this.tables.detected.hydrate(literals.detected, entities.detected, this.scopeKey) +
      this.tables.registryDerived.hydrate(literals.registry, entities.registry, this.scopeKey);
    if (restoreOnly > 0 && !this.warnedRestoreOnly) {
      this.warnedRestoreOnly = true;
      this.warn(
        { restoreOnly },
        "vault store holds tokens minted under a different surrogate key or style; they restore but are not re-minted",
      );
    }
  }

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof VaultStoreError) throw err;
      throw new VaultStoreError(operation, err);
    }
  }
}

function entryKey(entry: VaultEntry): string {
  return `${entry.layer}\u0000${entry.token}`;
}

function fingerprint(entry: VaultEntry): string {
  return JSON.stringify(entry);
}
