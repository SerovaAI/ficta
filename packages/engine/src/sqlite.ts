// @serovaai/ficta-engine/sqlite: a persistent, encrypted VaultStore on Node's built-in SQLite.
//
// Requires Node >= 22.13 (`node:sqlite` without a flag); Node 24 LTS is recommended. The main
// `@serovaai/ficta-engine` entry never imports this file, so it stays SQLite-free and loads on Node 20.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type SealedVaultEntry, VaultCipher, type VaultEncryptionKey } from "./vault-crypto.js";
import type { VaultEntry, VaultLayer, VaultStore } from "./vault-store.js";

export { InvalidVaultKeyError, type VaultEncryptionKey, VaultDecryptError } from "./vault-crypto.js";
export type { VaultEntry, VaultStore } from "./vault-store.js";

export interface SqliteVaultStoreOptions {
  /**
   * 32-byte key that encrypts values at rest (raw bytes, 64 hex characters, or base64). Separate
   * from the surrogate key, and protected like it: anyone with the file and this key can read every
   * stored value.
   */
  readonly encryptionKey: VaultEncryptionKey;
  /** How long a write waits for another connection's lock before failing, in ms. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/** Schema version this build reads and writes (`PRAGMA user_version`). */
export const SQLITE_VAULT_SCHEMA_VERSION = 1;

/** The vault file was written under a different encryption key. */
export class VaultKeyMismatchError extends Error {
  constructor() {
    super("vault encryption key does not match the key this vault file was created with");
    this.name = "VaultKeyMismatchError";
  }
}

/** The vault file's schema is newer than this ficta-engine understands. */
export class VaultSchemaError extends Error {
  constructor(found: number) {
    super(
      `vault schema version ${found} is newer than this ficta-engine supports (${SQLITE_VAULT_SCHEMA_VERSION}); upgrade ficta-engine`,
    );
    this.name = "VaultSchemaError";
  }
}

/** Open (creating if needed) an encrypted SQLite vault at `path`. */
export function openSqliteVaultStore(path: string, opts: SqliteVaultStoreOptions): SqliteVaultStore {
  return new SqliteVaultStore(path, opts);
}

const LAYERS: ReadonlySet<string> = new Set<VaultLayer>(["detected", "registry"]);
/** Bound parameters per IN (...) list, well under SQLite's default limit. */
const IN_CHUNK = 500;

/**
 * A {@link VaultStore} on `node:sqlite`'s `DatabaseSync`. Each connection runs in WAL mode with a
 * busy timeout, so several processes on one machine can share one file: reads never block, and
 * writes queue one at a time in short `BEGIN IMMEDIATE` transactions. Use local disk only (WAL needs
 * shared memory, which network filesystems do not provide). Back up with the SQLite backup API or
 * copy the `-wal` and `-shm` files with the database.
 *
 * Calls are synchronous underneath (small indexed reads and writes) and return resolved promises to
 * satisfy the async interface.
 */
export class SqliteVaultStore implements VaultStore {
  private readonly db: DatabaseSync;
  private readonly cipher: VaultCipher;
  private closed = false;

  constructor(path: string, opts: SqliteVaultStoreOptions) {
    this.cipher = new VaultCipher(opts.encryptionKey);
    const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError("busyTimeoutMs must be a non-negative integer");
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
      this.verifyKey();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  async load(scope: string): Promise<readonly VaultEntry[]> {
    const rows = this.db
      .prepare("SELECT layer, token, version, value_lookup, iv, ciphertext FROM vault_entries WHERE scope = ?")
      .all(scope);
    return rows.map((row) => this.cipher.open(scope, sealedRow(row)));
  }

  async lookup(scope: string, tokens: readonly string[]): Promise<readonly VaultEntry[]> {
    const out: VaultEntry[] = [];
    for (const chunk of chunks([...new Set(tokens)])) {
      const rows = this.db
        .prepare(
          `SELECT layer, token, version, value_lookup, iv, ciphertext FROM vault_entries
           WHERE scope = ? AND token IN (${placeholders(chunk.length)})`,
        )
        .all(scope, ...chunk);
      for (const row of rows) out.push(this.cipher.open(scope, sealedRow(row)));
    }
    return out;
  }

  async append(scope: string, entries: readonly VaultEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    const sealed = entries.map((entry) => this.cipher.seal(scope, entry)); // encrypt outside the lock
    const upsert = this.db.prepare(
      `INSERT INTO vault_entries (scope, layer, token, version, value_lookup, iv, ciphertext, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, layer, token) DO UPDATE SET
         version = excluded.version,
         value_lookup = excluded.value_lookup,
         iv = excluded.iv,
         ciphertext = excluded.ciphertext,
         last_used_at = max(vault_entries.last_used_at, excluded.last_used_at)`,
    );
    this.transaction(() => {
      for (const entry of sealed) {
        upsert.run(
          scope,
          entry.layer,
          entry.token,
          entry.version,
          entry.valueLookup,
          entry.iv,
          entry.ciphertext,
          now,
          now,
        );
      }
    });
  }

  async touch(scope: string, tokens: readonly string[], at: Date): Promise<void> {
    const unique = [...new Set(tokens)];
    if (unique.length === 0) return;
    const ms = at.getTime();
    this.transaction(() => {
      for (const chunk of chunks(unique)) {
        this.db
          .prepare(
            `UPDATE vault_entries SET last_used_at = max(last_used_at, ?)
             WHERE scope = ? AND token IN (${placeholders(chunk.length)})`,
          )
          .run(ms, scope, ...chunk);
      }
    });
  }

  async prune(opts: { readonly notUsedSince: Date }): Promise<number> {
    const cutoff = opts.notUsedSince.getTime();
    return this.transaction(() =>
      Number(this.db.prepare("DELETE FROM vault_entries WHERE last_used_at < ?").run(cutoff).changes),
    );
  }

  async forget(value: string, opts: { readonly scope?: string } = {}): Promise<number> {
    const lookup = this.cipher.valueLookup(value);
    return this.transaction(() => {
      const result =
        opts.scope === undefined
          ? this.db.prepare("DELETE FROM vault_entries WHERE value_lookup = ?").run(lookup)
          : this.db.prepare("DELETE FROM vault_entries WHERE value_lookup = ? AND scope = ?").run(lookup, opts.scope);
      return Number(result.changes);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back (SQLite aborts the transaction on some errors); keep the original error.
      }
      throw err;
    }
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SQLITE_VAULT_SCHEMA_VERSION) throw new VaultSchemaError(version);
    if (version === SQLITE_VAULT_SCHEMA_VERSION) return;
    this.transaction(() => {
      // Re-read inside the write lock: another process may have migrated while this one waited.
      const current = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (current >= 1) return;
      this.db.exec(`
        CREATE TABLE vault_meta (
          key TEXT PRIMARY KEY,
          iv BLOB NOT NULL,
          ciphertext BLOB NOT NULL
        );
        CREATE TABLE vault_entries (
          scope TEXT NOT NULL,
          layer TEXT NOT NULL CHECK (layer IN ('detected', 'registry')),
          token TEXT NOT NULL,
          version INTEGER NOT NULL,
          value_lookup BLOB NOT NULL,
          iv BLOB NOT NULL,
          ciphertext BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          PRIMARY KEY (scope, layer, token)
        );
        CREATE INDEX vault_entries_scope_token ON vault_entries (scope, token);
        CREATE INDEX vault_entries_value_lookup ON vault_entries (value_lookup);
        CREATE INDEX vault_entries_last_used ON vault_entries (last_used_at);
      `);
      const check = this.cipher.keyCheck();
      this.db
        .prepare("INSERT INTO vault_meta (key, iv, ciphertext) VALUES ('key_check', ?, ?)")
        .run(check.iv, check.ciphertext);
      this.db.exec(`PRAGMA user_version = ${SQLITE_VAULT_SCHEMA_VERSION}`);
    });
  }

  private verifyKey(): void {
    const row = this.db.prepare("SELECT iv, ciphertext FROM vault_meta WHERE key = 'key_check'").get() as
      | { iv: Uint8Array; ciphertext: Uint8Array }
      | undefined;
    if (!row || !this.cipher.verifyKeyCheck(row)) throw new VaultKeyMismatchError();
  }
}

function sealedRow(row: Record<string, SQLInputValue>): SealedVaultEntry {
  const layer = String(row.layer);
  if (!LAYERS.has(layer)) throw new Error("vault row has an unknown layer");
  return {
    layer: layer as VaultLayer,
    token: String(row.token),
    version: Number(row.version),
    valueLookup: row.value_lookup as Uint8Array,
    iv: row.iv as Uint8Array,
    ciphertext: row.ciphertext as Uint8Array,
  };
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += IN_CHUNK) yield items.slice(i, i + IN_CHUNK);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
