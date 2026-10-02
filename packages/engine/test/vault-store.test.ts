import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EngineConfigInput, MissingSurrogateKeyError, ProtectionEngine } from "../src/index.js";
import type { DetectorPlugin, ProtectedValue, RegistrySourcePlugin } from "../src/plugins/types.js";
import {
  type ProtectionRecord,
  protectionRecordSurfaces,
  type StructuredRegistrySourceCapabilities,
} from "../src/protection.js";
import {
  InvalidVaultKeyError,
  openSqliteVaultStore,
  SQLITE_VAULT_SCHEMA_VERSION,
  type SqliteVaultStore,
  VaultDecryptError,
  VaultKeyMismatchError,
} from "../src/sqlite.js";
import { VaultCipher } from "../src/vault-crypto.js";
import { type VaultEntry, type VaultStore, VaultStoreError } from "../src/vault-store.js";

// Persistent vault: two engine instances (standing in for two processes, e.g. a batch job and a
// long-running service on one machine) share one encrypted SQLite file.

const SURROGATE_KEY = "vault-store-test-surrogate-key-at-least-32-bytes";
const ENCRYPTION_KEY = "a1".repeat(32); // 64 hex characters = 32 bytes, distinct from the surrogate key
const OTHER_ENCRYPTION_KEY = Buffer.alloc(32, 9);
const SCOPE = "org:thread-1";
const EMAIL = "pat.example@example.com";
const OTHER_EMAIL = "lee.example@example.org";
const CARD = "4111 1111 1111 1111";
const ORG = "Northstar Biologics (Pty) Ltd";
const ORG_ID = "entity-northstar";

let dir: string;
let path: string;
const opened: VaultStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ficta-vault-"));
  path = join(dir, "vault.db");
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(opts: { busyTimeoutMs?: number; encryptionKey?: string | Uint8Array } = {}): SqliteVaultStore {
  const store = openSqliteVaultStore(path, { encryptionKey: ENCRYPTION_KEY, ...opts });
  opened.push(store);
  return store;
}

function valueDetector(category: string, values: readonly string[]): DetectorPlugin {
  return {
    kind: "detector",
    name: `fixture-${category}`,
    bodyDetectionView: "content",
    detectText: (text) =>
      values
        .filter((value) => text.includes(value))
        .map((value): ProtectedValue => ({
          name: category,
          value,
          source: "fixture",
          kind: "pii",
          confidence: "high",
        })),
  };
}

function structuredRegistry(
  records: readonly ProtectionRecord[],
): RegistrySourcePlugin & StructuredRegistrySourceCapabilities {
  return {
    kind: "registry-source",
    name: "structured-fixture",
    config: { bindings: [], sections: [], envDefaults: {} },
    setup: { registrySources: () => [] },
    discover: () => [],
    loadValues: () => records.flatMap(protectionRecordSurfaces),
    loadProtectionRecords: () => records,
    fatalLoadErrors: true,
  };
}

const ORG_RECORD: ProtectionRecord = {
  protectionKind: "entity",
  entityId: ORG_ID,
  entityType: "organization",
  canonical: { formId: `${ORG_ID}:canonical`, value: ORG },
  forms: [{ formId: `${ORG_ID}:form:0`, value: "Northstar", kind: "short_name", boundary: "token" }],
  provenance: "registry",
  meta: { name: "organization", value: ORG, source: "fixture", kind: "pii", confidence: "exact" },
};

/** One "process": its own engine and its own store connection to the shared file. */
function engineWith(store: VaultStore | undefined, config: EngineConfigInput = {}): ProtectionEngine {
  return new ProtectionEngine({
    plugins: [
      structuredRegistry([ORG_RECORD]),
      valueDetector("email", [EMAIL, OTHER_EMAIL]),
      valueDetector("credit-card", [CARD]),
    ],
    config: { surrogate: { key: SURROGATE_KEY, style: "typed" }, ...config },
    vault: store,
  });
}

function tokensIn(text: string): string[] {
  return [...new Set(text.match(/FICTA_[A-Z0-9]+_[0-9a-fA-Z2-7_]+/g) ?? [])];
}

function rawRows(): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM vault_entries").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function rawBytesContain(value: string): boolean {
  const needle = Buffer.from(value, "utf8");
  return rawRows().some((row) =>
    Object.values(row).some((cell) =>
      typeof cell === "string"
        ? cell.includes(value)
        : cell instanceof Uint8Array && Buffer.from(cell).includes(needle),
    ),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("persistent vault across engine instances", () => {
  it("restores tokens another instance minted, and both mint identical tokens", async () => {
    const a = engineWith(open());
    const b = engineWith(open());
    const text = `${ORG} wrote to ${EMAIL} about Northstar.`;

    const fromA = await a.beginRequest(SCOPE).redactContentDetailed(text);
    expect(fromA.text).not.toContain(EMAIL);
    expect(fromA.text).toMatch(/FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}/);
    expect(fromA.text).toMatch(/FICTA_EMAIL_[0-9a-f]{32}/);

    const scopeB = b.beginRequest(SCOPE);
    expect(scopeB.restoreText(fromA.text)).toBe(fromA.text); // nothing in memory yet
    await scopeB.prepareRestore(fromA.text);
    expect(scopeB.restoreText(fromA.text)).toBe(text);

    // Independent pseudonymisation in B yields byte-identical tokens (entity family included).
    const fromB = await b.beginRequest(SCOPE).redactContentDetailed(text);
    expect(fromB.text).toBe(fromA.text);
  });

  it("fetches tokens minted after this instance hydrated (restore miss)", async () => {
    const a = engineWith(open());
    const b = engineWith(open());
    const scopeB = b.beginRequest(SCOPE);
    await scopeB.hydrate(); // B loads an empty scope first

    const later = await a.beginRequest(SCOPE).redactContentDetailed(`mail ${OTHER_EMAIL}`);
    expect(await scopeB.prepareRestore(later.text)).toBe(1);
    expect(scopeB.restoreText(later.text)).toBe(`mail ${OTHER_EMAIL}`);
    expect(await scopeB.prepareRestore(later.text)).toBe(0); // already mapped
  });

  it("keeps the vault across a restart (close and reopen)", async () => {
    const first = open();
    const a = engineWith(first);
    const text = `${ORG} and ${EMAIL}`;
    const redacted = await a.beginRequest(SCOPE).redactContentDetailed(text);
    await a.flushVault();
    await first.close();

    const restarted = engineWith(open()).beginRequest(SCOPE);
    await restarted.hydrate();
    expect(restarted.restoreJson(JSON.stringify({ text: redacted.text }))).toBe(JSON.stringify({ text }));
  });

  it("re-redacts persisted values a fresh instance's detectors would miss", async () => {
    const a = engineWith(open());
    await a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL}`);
    const blind = new ProtectionEngine({
      plugins: [],
      config: { surrogate: { key: SURROGATE_KEY, style: "typed" } },
      vault: open(),
    });
    const result = await blind.beginRequest(SCOPE).redactContentDetailed(`again ${EMAIL}`);
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).toMatch(/^again FICTA_EMAIL_[0-9a-f]{32}$/);
  });

  it("keeps scopes apart: another scope key cannot restore", async () => {
    const a = engineWith(open());
    const redacted = await a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL}`);
    const other = engineWith(open()).beginRequest("org:thread-2");
    await other.prepareRestore(redacted.text);
    expect(other.restoreText(redacted.text)).toBe(redacted.text);
  });

  it("persists the entity-tag owner map so the collision check survives restarts", async () => {
    const a = engineWith(open());
    await a.beginRequest(SCOPE).redactContentDetailed(`${ORG} said hi`);
    const entries = await open().load(SCOPE);
    const entity = entries.find((entry) => entry.type === "entity");
    expect(entity).toMatchObject({ type: "entity", entityId: ORG_ID, entityType: "organization" });
    expect(entity?.type === "entity" && entity.token.includes(entity.entityTag)).toBe(true);
  });

  it("requires a configured surrogate key when a store is attached", () => {
    expect(() => new ProtectionEngine({ plugins: [], allowEphemeralKey: true, vault: open(), config: {} })).toThrow(
      MissingSurrogateKeyError,
    );
  });

  it("leaves engines without a store unchanged (in-memory only)", async () => {
    const a = engineWith(undefined);
    const scope = a.beginRequest(SCOPE);
    const redacted = await scope.redactContentDetailed(`mail ${EMAIL}`);
    await scope.hydrate();
    expect(await scope.prepareRestore(redacted.text)).toBe(0);
    expect(scope.restoreText(redacted.text)).toBe(`mail ${EMAIL}`);
  });
});

describe("persistent vault contents", () => {
  it("never stores destroyed values", async () => {
    const store = open();
    const a = engineWith(store, { dispositions: { destroy: { categories: ["credit-card"] } } });
    const text = `Card ${CARD}, receipt to ${EMAIL}.`;
    const redacted = await a.beginRequest(SCOPE).redactContentDetailed(text);
    expect(redacted.text).toContain("[REDACTED_CREDIT_CARD]");
    await a.beginRequest(SCOPE).redactTextDetailed(`card=${CARD}`, { surface: "header", preservePaths: false });

    const entries = await store.load(SCOPE);
    expect(entries.some((entry) => entry.value === EMAIL)).toBe(true);
    expect(entries.some((entry) => entry.value.includes(CARD))).toBe(false);
    expect(JSON.stringify(entries)).not.toContain(CARD);
    expect(rawBytesContain(CARD)).toBe(false);
    expect(await store.forget(CARD)).toBe(0); // no row carries its lookup hash
  });

  it("encrypts values: no plaintext value in any raw column, tokens in clear", async () => {
    const a = engineWith(open());
    const redacted = await a.beginRequest(SCOPE).redactContentDetailed(`${ORG} and ${EMAIL}`);
    const rows = rawRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rawBytesContain(EMAIL)).toBe(false);
    expect(rawBytesContain("Northstar")).toBe(false);
    expect(rawBytesContain(ORG_ID)).toBe(false);
    for (const token of tokensIn(redacted.text)) expect(rows.some((row) => row.token === token)).toBe(true);
    for (const row of rows) {
      expect((row.iv as Uint8Array).length).toBe(12);
      expect(row.scope).toBe(SCOPE);
    }
  });

  it("uses WAL and records the schema version", () => {
    open();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SQLITE_VAULT_SCHEMA_VERSION });
      const indexes = db
        .prepare("PRAGMA index_list(vault_entries)")
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining(["vault_entries_scope_token", "vault_entries_value_lookup", "vault_entries_last_used"]),
      );
    } finally {
      db.close();
    }
  });

  it("records last use on restore", async () => {
    const a = engineWith(open());
    const redacted = await a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL}`);
    const before = Math.max(...rawRows().map((row) => Number(row.last_used_at)));
    await sleep(5);
    const b = engineWith(open());
    const scope = b.beginRequest(SCOPE);
    await scope.prepareRestore(redacted.text);
    scope.restoreText(redacted.text);
    await b.flushVault();
    const [token] = tokensIn(redacted.text);
    const row = rawRows().find((candidate) => candidate.token === token);
    expect(Number(row?.last_used_at)).toBeGreaterThan(before);
  });
});

describe("retention", () => {
  it("prunes entries not used since a cutoff; their tokens then pass through unrestored", async () => {
    const store = open();
    const a = engineWith(store);
    const old = await a.beginRequest(SCOPE).redactContentDetailed(`old ${EMAIL}`);
    await sleep(5);
    const cutoff = new Date();
    await sleep(5);
    const recent = await a.beginRequest(SCOPE).redactContentDetailed(`new ${OTHER_EMAIL}`);
    await a.flushVault();

    expect(await store.prune({ notUsedSince: cutoff })).toBeGreaterThan(0);

    const fresh = engineWith(open()).beginRequest(SCOPE);
    const both = `${old.text} | ${recent.text}`;
    await fresh.prepareRestore(both);
    // F8's unknown-token placeholder is not built yet: a pruned token passes through as-is.
    expect(fresh.restoreText(both)).toBe(`${old.text} | new ${OTHER_EMAIL}`);
  });

  it("forgets one exact value in every scope", async () => {
    const store = open();
    const a = engineWith(store);
    const one = await a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL} and ${OTHER_EMAIL}`);
    await a.beginRequest("org:thread-2").redactContentDetailed(`mail ${EMAIL}`);

    expect(await store.forget(EMAIL)).toBe(2);
    expect((await store.load(SCOPE)).some((entry) => entry.value === EMAIL)).toBe(false);
    expect((await store.load("org:thread-2")).some((entry) => entry.value === EMAIL)).toBe(false);
    expect((await store.load(SCOPE)).some((entry) => entry.value === OTHER_EMAIL)).toBe(true);

    const fresh = engineWith(open()).beginRequest(SCOPE);
    await fresh.prepareRestore(one.text);
    const restored = fresh.restoreText(one.text);
    expect(restored).not.toContain(EMAIL);
    expect(restored).toContain(OTHER_EMAIL);
  });

  it("forgets only within one scope when asked", async () => {
    const store = open();
    const a = engineWith(store);
    await a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL}`);
    await a.beginRequest("org:thread-2").redactContentDetailed(`mail ${EMAIL}`);
    expect(await store.forget(EMAIL, { scope: SCOPE })).toBe(1);
    expect((await store.load("org:thread-2")).some((entry) => entry.value === EMAIL)).toBe(true);
  });
});

describe("vault encryption", () => {
  const entry = (token: string, value: string): VaultEntry => ({
    type: "literal",
    layer: "detected",
    token,
    value,
    hint: { name: "email", kind: "pii" },
    matchForm: true,
    wordBounded: false,
    tokenOnly: false,
  });

  it("binds each ciphertext to its scope, layer, and token", () => {
    const cipher = new VaultCipher(ENCRYPTION_KEY);
    const sealed = cipher.seal(SCOPE, entry("FICTA_EMAIL_aa", EMAIL));
    expect(cipher.open(SCOPE, sealed)).toEqual(entry("FICTA_EMAIL_aa", EMAIL));
    expect(() => cipher.open("org:other", sealed)).toThrow(VaultDecryptError);
    expect(() => cipher.open(SCOPE, { ...sealed, token: "FICTA_EMAIL_bb" })).toThrow(VaultDecryptError);
    expect(() => cipher.open(SCOPE, { ...sealed, layer: "registry" })).toThrow(VaultDecryptError);
    expect(() => cipher.open(SCOPE, { ...sealed, version: 2 })).toThrow(VaultDecryptError);
  });

  it("fails to load when ciphertexts are swapped between rows", async () => {
    const store = open();
    await engineWith(store).beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL} and ${OTHER_EMAIL}`);
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare("SELECT token, iv, ciphertext FROM vault_entries ORDER BY token").all();
      const [first, second] = rows;
      if (!first || !second) throw new Error("expected two rows");
      const update = db.prepare("UPDATE vault_entries SET iv = ?, ciphertext = ? WHERE token = ?");
      update.run(second.iv as Uint8Array, second.ciphertext as Uint8Array, first.token as string);
      update.run(first.iv as Uint8Array, first.ciphertext as Uint8Array, second.token as string);
    } finally {
      db.close();
    }
    await expect(store.load(SCOPE)).rejects.toThrow(VaultDecryptError);

    // Through the engine, the failure surfaces as a values-free VaultStoreError.
    const scope = engineWith(open()).beginRequest(SCOPE);
    const error = await scope.hydrate().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(VaultStoreError);
    expect(String(error)).not.toContain(EMAIL);
  });

  it("refuses a wrong encryption key clearly", async () => {
    open();
    expect(() => open({ encryptionKey: OTHER_ENCRYPTION_KEY })).toThrow(VaultKeyMismatchError);
    const wrong = new VaultCipher(OTHER_ENCRYPTION_KEY);
    const sealed = new VaultCipher(ENCRYPTION_KEY).seal(SCOPE, entry("FICTA_EMAIL_aa", EMAIL));
    expect(() => wrong.open(SCOPE, sealed)).toThrow(VaultDecryptError);
  });

  it.each([
    ["an empty key", ""],
    ["a short key", "too-short"],
    ["a 31-byte buffer", Buffer.alloc(31, 1)],
    ["a passphrase", "correct horse battery staple correct horse battery staple"],
  ])("rejects %s without echoing it", (_, key) => {
    let thrown: unknown;
    try {
      new VaultCipher(key);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidVaultKeyError);
    if (typeof key === "string" && key) expect(String(thrown)).not.toContain(key);
  });

  it("accepts hex, base64, base64url, and raw bytes", () => {
    const raw = Buffer.alloc(32, 0xfb);
    for (const key of [raw, raw.toString("hex"), raw.toString("base64"), raw.toString("base64url")]) {
      const sealed = new VaultCipher(key).seal(SCOPE, entry("FICTA_EMAIL_aa", EMAIL));
      expect(new VaultCipher(raw).open(SCOPE, sealed).value).toBe(EMAIL);
    }
  });

  it("pads plaintext so ciphertext length only roughly bounds value length", () => {
    const cipher = new VaultCipher(ENCRYPTION_KEY);
    const short = cipher.seal(SCOPE, entry("FICTA_EMAIL_aa", "x"));
    const longer = cipher.seal(SCOPE, entry("FICTA_EMAIL_aa", "x".repeat(5)));
    expect(short.ciphertext.length).toBe(longer.ciphertext.length);
    for (const length of [1, 63, 64, 200]) {
      const sealed = cipher.seal(SCOPE, entry("FICTA_EMAIL_aa", "x".repeat(length)));
      expect((sealed.ciphertext.length - 16) % 64).toBe(0); // padded blocks + 16-byte GCM tag
    }
  });
});

describe("store failures and concurrency", () => {
  it("fails redaction with VaultStoreError when new mappings cannot be saved, and retries later", async () => {
    const backing = open();
    let failing = true;
    const flaky: VaultStore = {
      load: (scope) => backing.load(scope),
      lookup: (scope, tokens) => backing.lookup(scope, tokens),
      append: (scope, entries) => (failing ? Promise.reject(new Error("disk full")) : backing.append(scope, entries)),
      touch: (scope, tokens, at) => backing.touch(scope, tokens, at),
      prune: (opts) => backing.prune(opts),
      forget: (value, opts) => backing.forget(value, opts),
      close: async () => {},
    };
    const a = engineWith(flaky);
    await expect(a.beginRequest(SCOPE).redactContentDetailed(`mail ${EMAIL}`)).rejects.toThrow(VaultStoreError);
    failing = false;
    await a.beginRequest(SCOPE).redactContentDetailed("nothing sensitive here");
    expect((await backing.load(SCOPE)).some((entry) => entry.value === EMAIL)).toBe(true);
  });

  it("interleaves appends from two connections without losing entries", async () => {
    const first = open();
    const second = open();
    const cipherEntry = (i: number): VaultEntry => ({
      type: "literal",
      layer: "detected",
      token: `FICTA_EMAIL_${i.toString(16).padStart(32, "0")}`,
      value: `user${i}@example.com`,
      hint: { name: "email", kind: "pii" },
      matchForm: true,
      wordBounded: false,
      tokenOnly: false,
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? first : second).append(SCOPE, [cipherEntry(i)])),
    );
    expect(await first.load(SCOPE)).toHaveLength(40);
  });

  it("waits out another process's write lock under the busy timeout", async () => {
    const store = open({ busyTimeoutMs: 5000 });
    const impatient = open({ busyTimeoutMs: 0 });
    const holder = join(dir, "hold-lock.mjs");
    writeFileSync(
      holder,
      [
        'import { DatabaseSync } from "node:sqlite";',
        "const db = new DatabaseSync(process.argv[2]);",
        'db.exec("BEGIN IMMEDIATE");',
        'process.stdout.write("locked\\n");',
        "const until = Date.now() + Number(process.argv[3]);",
        "while (Date.now() < until) {}",
        'db.exec("COMMIT");',
        "db.close();",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--no-warnings", holder, path, "400"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("locked")) resolve();
      });
    });

    const entry: VaultEntry = {
      type: "literal",
      layer: "detected",
      token: `FICTA_EMAIL_${"c".repeat(32)}`,
      value: EMAIL,
      hint: {},
      matchForm: true,
      wordBounded: false,
      tokenOnly: false,
    };
    await expect(impatient.append(SCOPE, [entry])).rejects.toThrow(/locked|busy/i);
    const started = Date.now();
    await store.append(SCOPE, [entry]);
    expect(Date.now() - started).toBeGreaterThan(50); // it really waited for the other process
    expect(await exited).toBe(0);
    expect(await store.load(SCOPE)).toHaveLength(1);
  });
});
