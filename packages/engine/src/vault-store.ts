import type { ProtectedValue, ProtectedValueKind } from "./plugins/types.js";

/**
 * Persistent vault storage: the seam that lets a keyed scope's value↔token mappings outlive one
 * process, so a batch job and a long-running service sharing one vault on one machine can restore
 * each other's tokens.
 *
 * The interface is written in domain terms (load a scope, look up tokens, append mappings, record
 * use, prune, forget), not SQL, so a backend can be swapped without touching the token layer. The
 * engine ships one backend, `@serovaai/ficta-engine/sqlite`. A backend receives plaintext entries
 * and is responsible for encrypting them at rest: {@link VaultCipher} (`vault-crypto.ts`) does that
 * in the engine so every backend seals entries the same way.
 *
 * Every method is async. SQLite's `DatabaseSync` could answer synchronously, but a network backend
 * (Postgres) cannot, and one interface must serve both. The engine already awaits on its redaction
 * paths, so the cost is one resolved promise per call; the synchronous restore methods keep working
 * on in-memory state that an explicit `hydrate()` / `prepareRestore()` fills first.
 */
export interface VaultStore {
  /** Every entry stored for `scope`, in any order. */
  load(scope: string): Promise<readonly VaultEntry[]>;
  /** Entries for the given tokens in `scope` (a restore of tokens this process has not seen yet). */
  lookup(scope: string, tokens: readonly string[]): Promise<readonly VaultEntry[]>;
  /**
   * Insert or update entries, keyed by (scope, layer, token). Idempotent and add-only: nothing is
   * ever removed by an append, and re-appending an entry only refreshes its flags and last use.
   */
  append(scope: string, entries: readonly VaultEntry[]): Promise<void>;
  /** Record that these tokens were used (emitted or restored) at `at`. Unknown tokens are ignored. */
  touch(scope: string, tokens: readonly string[], at: Date): Promise<void>;
  /** Delete every entry, in every scope, last used before `notUsedSince`. Returns how many went. */
  prune(opts: { readonly notUsedSince: Date }): Promise<number>;
  /**
   * Delete every entry for one exact raw value (all scopes, or just `scope`), without the store ever
   * holding that value in plaintext. Returns how many entries went.
   */
  forget(value: string, opts?: { readonly scope?: string }): Promise<number>;
  /** Release the backend's resources. The store must not be used afterwards. */
  close(): Promise<void>;
}

/** Which keyed-scope table an entry belongs to: detector findings, or registry-derived surfaces. */
export type VaultLayer = "detected" | "registry";

/** Safe labels kept for a detected value (category, source, plugin): never the value itself. */
export type VaultEntryMetadata = Omit<ProtectedValue, "value" | "spans">;

interface VaultEntryBase {
  readonly layer: VaultLayer;
  /** The surrogate token. Stored in clear: it is what already leaves the machine. */
  readonly token: string;
  /** The raw value the token restores to. Encrypted at rest. */
  readonly value: string;
}

/** A plain value↔token mapping, with what is needed to re-admit it to matching after a restart. */
export interface VaultLiteralEntry extends VaultEntryBase {
  readonly type: "literal";
  /** Category/kind the token was minted with (typed surrogates carry it in the token). */
  readonly hint: { readonly name?: string; readonly kind?: ProtectedValueKind };
  /** The value is matched in future text (false: restore-only, e.g. a clipped residual). */
  readonly matchForm: boolean;
  /** Matched only at token boundaries. */
  readonly wordBounded: boolean;
  /** Restores, but never becomes a future entity-expansion candidate. */
  readonly tokenOnly: boolean;
  /** Detection labels for the value, used for hits and entity expansion. */
  readonly metadata?: VaultEntryMetadata;
}

/**
 * An entity-family token (`FICTA_ORG_…` / `FICTA_PERSON_…`). Its tags are bound to the scope key, so
 * the entity id and the tag's owner are persisted too: that keeps the per-scope entity-tag collision
 * check working across restarts.
 */
export interface VaultEntityEntry extends VaultEntryBase {
  readonly type: "entity";
  readonly entityId: string;
  readonly entityType: "organization" | "person";
  readonly entityTag: string;
}

export type VaultEntry = VaultLiteralEntry | VaultEntityEntry;

/**
 * A persistent vault store failed (unreachable, locked, corrupt, or undecryptable). Thrown by the
 * engine's redaction methods when new mappings cannot be saved, so a caller never sends out tokens
 * that a later process could not restore. The message never contains a protected value.
 */
export class VaultStoreError extends Error {
  constructor(operation: string, cause?: unknown) {
    super(`vault store ${operation} failed${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "VaultStoreError";
    if (cause !== undefined) this.cause = cause;
  }
}
