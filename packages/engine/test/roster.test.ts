import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngine,
  type CreateEngineOptions,
  type FictaEngine,
  InvalidEngineConfigError,
  RedactionUnavailableError,
  type RosterEntry,
  type RosterSource,
} from "../src/index.js";
import { openSqliteVaultStore, type SqliteVaultStore } from "../src/sqlite.js";
import { ScopedVault } from "../src/vault.js";

// The library roster: an embedding application supplies known people and organisations; the engine
// matches them exactly before detection and links their surfaces under one entity token family.

const SURROGATE_KEY = "roster-test-surrogate-key-at-least-32-bytes";
const OTHER_SURROGATE_KEY = "roster-test-other-surrogate-key-32-bytes!";
const ENCRYPTION_KEY = "d4".repeat(32); // 64 hex characters = 32 bytes, distinct from the surrogate key
const SCOPE = "owner";

const ANNA = "Anna Berg";
const ANNA_SHORT = "Anna";
const ANNA_EMAIL = "anna.berg@example.com";
const LINA = "Lina Lind";
const NORTHSTAR = "Northstar Biologics";
const UNREGISTERED = "Mira Holt";

const ROSTER: readonly RosterEntry[] = [
  { id: "contact-1", type: "person", canonical: ANNA, forms: [ANNA_SHORT, ANNA_EMAIL] },
  { id: "contact-2", type: "person", canonical: LINA, forms: ["Lina"] },
  { id: "org-7", type: "organization", canonical: NORTHSTAR, forms: ["Northstar"] },
];

const ENTITY_TOKEN = /FICTA_(PERSON|ORG)_([A-Z2-7]{12})_([A-Z2-7]{12})/g;
const LITERAL_TOKEN = /FICTA_[A-Z]+_[0-9a-f]{32}/g;

/** A Presidio stand-in that finds person names from a fixed list, and email addresses. */
let stub: { server: Server; url: string; persons: string[] };

function spansFor(text: string) {
  const spans: { entity_type: string; start: number; end: number; score: number }[] = [];
  for (const name of stub.persons) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    for (const match of text.matchAll(re)) {
      spans.push({ entity_type: "PERSON", start: match.index, end: match.index + name.length, score: 0.85 });
    }
  }
  for (const match of text.matchAll(/[\w.]+@[\w.]+\.\w+/g)) {
    spans.push({ entity_type: "EMAIL_ADDRESS", start: match.index, end: match.index + match[0].length, score: 1 });
  }
  return spans;
}

beforeAll(async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as { text: string };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(spansFor(payload.text)));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  stub = { server, url: `http://127.0.0.1:${port}`, persons: [] };
});

afterAll(async () => {
  stub.server.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

let dir: string;
let path: string;
const engines: FictaEngine[] = [];

beforeEach(() => {
  stub.persons = [ANNA, ANNA_SHORT, LINA, UNREGISTERED];
  dir = mkdtempSync(join(tmpdir(), "ficta-roster-"));
  path = join(dir, "vault.db");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROFILES: CreateEngineOptions["profiles"] = {
  pseudonymise: { entities: ["PERSON", "EMAIL_ADDRESS"], secretShapes: false },
  scrub: { entities: ["PERSON"], secretShapes: false, destroy: { categories: ["person"] } },
};

function openStore(): SqliteVaultStore {
  return openSqliteVaultStore(path, { encryptionKey: ENCRYPTION_KEY });
}

async function facade(opts: Partial<CreateEngineOptions> = {}): Promise<FictaEngine> {
  const engine = await createEngine({
    surrogateKey: SURROGATE_KEY,
    surrogateStyle: "typed",
    presidio: { url: stub.url },
    profiles: PROFILES,
    roster: ROSTER,
    ...opts,
  });
  engines.push(engine);
  return engine;
}

function entityTokens(text: string): { type: string; entity: string; surface: string; token: string }[] {
  return [...text.matchAll(ENTITY_TOKEN)].map((m) => ({
    token: m[0],
    type: m[1] ?? "",
    entity: m[2] ?? "",
    surface: m[3] ?? "",
  }));
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

describe("roster: linked entity tokens", () => {
  it("links the canonical name, a short form and an email under one entity tag, and restores each", async () => {
    const engine = await facade({ vault: openStore() });
    const text = `${ANNA} wrote. ${ANNA_SHORT} replied from ${ANNA_EMAIL}.`;
    const result = await engine.scope(SCOPE).pseudonymise(text, "pseudonymise");

    for (const value of [ANNA, ANNA_EMAIL]) expect(result.text).not.toContain(value);
    expect(result.text).not.toMatch(/\bAnna\b/);
    const tokens = entityTokens(result.text);
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens.map((t) => t.type))).toEqual(new Set(["PERSON"]));
    expect(new Set(tokens.map((t) => t.entity)).size).toBe(1);
    expect(new Set(tokens.map((t) => t.surface)).size).toBe(3);
    expect(result.hits.every((hit) => hit.disposition === "surrogate")).toBe(true);

    const restored = await engine.scope(SCOPE).restore(result.text);
    expect(restored).toEqual({ text, restoredCount: 3, unknownCount: 0 });
    // Each surface restores exactly, on its own.
    for (const { token } of tokens) {
      const single = (await engine.scope(SCOPE).restore(token)).text;
      expect([ANNA, ANNA_SHORT, ANNA_EMAIL]).toContain(single);
    }
  });

  it("matches roster forms in every profile, with registered names kept over a destroy disposition", async () => {
    const engine = await facade();
    const result = await engine.scope(SCOPE).pseudonymise(`${ANNA} met ${UNREGISTERED}.`, "scrub");
    expect(result.text).not.toContain(ANNA);
    expect(result.text).not.toContain(UNREGISTERED);
    expect(entityTokens(result.text)).toHaveLength(1);
    expect(result.text).toContain("[REDACTED_PERSON]");
    expect(result.destroyed).toBe(1);

    // A profile with no detection at all still applies the roster.
    const bare = await facade({ profiles: { none: { pii: false, secretShapes: false } } });
    const plain = await bare.scope(SCOPE).pseudonymise(`Ask ${NORTHSTAR} or Northstar.`, "none");
    const orgs = entityTokens(plain.text);
    expect(orgs).toHaveLength(2);
    expect(orgs.every((t) => t.type === "ORG")).toBe(true);
    expect(orgs[0]?.entity).toBe(orgs[1]?.entity);
  });

  it("gives an unregistered detected name its own unlinked token", async () => {
    const engine = await facade();
    const text = `${UNREGISTERED} and ${ANNA}`;
    const result = await engine.scope(SCOPE).pseudonymise(text, "pseudonymise");
    expect(result.text).not.toContain(UNREGISTERED);
    expect(entityTokens(result.text)).toHaveLength(1);
    expect(result.text.match(LITERAL_TOKEN)).toHaveLength(1);
    expect((await engine.scope(SCOPE).restore(result.text)).text).toBe(text);
  });

  it("matches short forms at word boundaries only", async () => {
    stub.persons = [];
    const engine = await facade();
    const result = await engine.scope(SCOPE).pseudonymise(`Annabel and ${ANNA_SHORT}.`, "pseudonymise");
    expect(result.text.startsWith("Annabel and FICTA_PERSON_")).toBe(true);
  });
});

describe("roster: determinism", () => {
  const TEXT = `${ANNA} (${ANNA_EMAIL}) asked ${LINA} about ${NORTHSTAR}.`;

  it("mints identical tokens in two engines on one store, whatever the roster order", async () => {
    const a = await facade({ vault: openStore() });
    const shuffled = [...ROSTER].reverse().map((entry) => ({ ...entry, forms: [...(entry.forms ?? [])].reverse() }));
    const b = await facade({ vault: openStore(), roster: shuffled });
    expect(b.rosterFingerprint).toBe(a.rosterFingerprint);

    const fromA = await a.scope(SCOPE).pseudonymise(TEXT, "pseudonymise");
    const fromB = await b.scope(SCOPE).pseudonymise(TEXT, "pseudonymise");
    expect(fromB.text).toBe(fromA.text);
    expect((await b.scope(SCOPE).restore(fromA.text)).text).toBe(TEXT);
  });

  it("keeps existing tokens when an unrelated entry is added", async () => {
    const a = await facade();
    const b = await facade({
      roster: [...ROSTER, { id: "contact-9", type: "person", canonical: "Pat Quinn", forms: ["Pat"] }],
    });
    const fromA = await a.scope(SCOPE).pseudonymise(TEXT, "pseudonymise");
    const fromB = await b.scope(SCOPE).pseudonymise(TEXT, "pseudonymise");
    expect(fromB.text).toBe(fromA.text);
    expect(b.rosterFingerprint).not.toBe(a.rosterFingerprint);
  });

  it("binds entity tags to the scope key", async () => {
    const engine = await facade();
    const one = await engine.scope("scope-one").pseudonymise(ANNA, "pseudonymise");
    const two = await engine.scope("scope-two").pseudonymise(ANNA, "pseudonymise");
    expect(entityTokens(one.text)[0]?.entity).not.toBe(entityTokens(two.text)[0]?.entity);
  });

  it("accepts a roster source, trimming and deduplicating forms", async () => {
    const source: RosterSource = {
      load: async () => [
        { ...ROSTER[0], forms: [` ${ANNA_SHORT} `, ANNA_SHORT, ANNA_EMAIL, ` ${ANNA} `] } as RosterEntry,
        ...ROSTER.slice(1),
      ],
    };
    const a = await facade({ roster: source });
    const b = await facade();
    expect(a.rosterSize).toBe(3);
    expect(a.rosterFingerprint).toBe(b.rosterFingerprint);
  });
});

describe("roster: ambiguity", () => {
  const SHARED: readonly RosterEntry[] = [
    { id: "contact-1", type: "person", canonical: ANNA, forms: [ANNA_SHORT] },
    { id: "contact-3", type: "person", canonical: "Anna Lind", forms: ["anna"] },
  ];

  it("links a form claimed by two entries to neither, and warns with counts only", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const engine = await facade({
      roster: SHARED,
      onWarn: (fields, message) => warnings.push({ fields, message }),
    });
    expect(engine.rosterAmbiguousForms).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ ambiguousForms: 1 });
    expect(JSON.stringify(warnings).toLowerCase()).not.toContain("anna");

    const result = await engine.scope(SCOPE).pseudonymise(`${ANNA} met Anna Lind. ${ANNA_SHORT} left.`, "pseudonymise");
    const linked = entityTokens(result.text);
    expect(linked).toHaveLength(2);
    expect(linked[0]?.entity).not.toBe(linked[1]?.entity);
    // The bare first name was found by detection only: an unlinked literal token.
    expect(result.text).not.toMatch(/\bAnna\b/);
    expect(result.text.match(LITERAL_TOKEN)).toHaveLength(1);
  });

  it("leaves an ambiguous form to detection when the detector misses it", async () => {
    stub.persons = [];
    const engine = await facade({ roster: SHARED });
    const result = await engine.scope(SCOPE).pseudonymise(`${ANNA_SHORT} left.`, "pseudonymise");
    expect(result.text).toBe(`${ANNA_SHORT} left.`);
  });

  it("rejects a canonical name claimed by another entry, without echoing it", async () => {
    const roster: RosterEntry[] = [
      { id: "contact-1", type: "person", canonical: ANNA },
      { id: "contact-2", type: "person", canonical: LINA, forms: ["anna  berg"] },
    ];
    const err = await facade({ roster }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidEngineConfigError);
    expect((err as Error).message).toContain("roster[1]");
    expect((err as Error).message.toLowerCase()).not.toContain("anna");
  });
});

describe("roster: validation", () => {
  const cases: [string, unknown][] = [
    ["not a list", { entries: [] }],
    ["empty id", [{ id: "", type: "person", canonical: ANNA }]],
    ["duplicate id", [ROSTER[0], { ...ROSTER[1], id: ROSTER[0]?.id }]],
    ["bad type", [{ id: "x", type: "place", canonical: ANNA }]],
    ["empty canonical", [{ id: "x", type: "person", canonical: "   " }]],
    ["non-string form", [{ id: "x", type: "person", canonical: ANNA, forms: [42] }]],
    ["one-character form", [{ id: "x", type: "person", canonical: ANNA, forms: ["A"] }]],
  ];
  for (const [label, roster] of cases) {
    it(`rejects ${label} with a values-free message`, async () => {
      const err = await facade({ roster: roster as RosterEntry[] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidEngineConfigError);
      for (const value of [ANNA, LINA, "contact-1", "contact-2"]) expect((err as Error).message).not.toContain(value);
    });
  }
});

describe("roster: fail-closed leak check", () => {
  it("throws internal_error when a roster form would survive redaction", async () => {
    stub.persons = [];
    const engine = await facade();
    // Simulate a resolver bug: no range is redactable, so the roster name survives untouched.
    vi.spyOn(ScopedVault.prototype, "isRedactableRange").mockReturnValue(false);
    const text = `Ping ${ANNA} today.`;
    const keyed = await engine
      .scope(SCOPE)
      .pseudonymise(text, "pseudonymise")
      .catch((e: unknown) => e);
    expect(keyed).toBeInstanceOf(RedactionUnavailableError);
    expect((keyed as RedactionUnavailableError).reason).toBe("internal_error");
    expect((keyed as Error).message).not.toContain(ANNA);

    const batch = await engine.redactMany([text], "pseudonymise").catch((e: unknown) => e);
    expect((batch as RedactionUnavailableError).reason).toBe("internal_error");
  });
});

describe("roster: persistence", () => {
  it("restores a token minted from an entry after the entry leaves the roster", async () => {
    const first = await facade({ vault: openStore() });
    const text = `${ANNA} and ${LINA}`;
    const redacted = await first.scope(SCOPE).pseudonymise(text, "pseudonymise");
    await first.close();

    const later = await facade({ vault: openStore(), roster: ROSTER.slice(1) });
    expect(await later.scope(SCOPE).restore(redacted.text)).toEqual({ text, restoredCount: 2, unknownCount: 0 });
    const none = await facade({ vault: openStore(), roster: undefined });
    expect((await none.scope(SCOPE).restore(redacted.text)).text).toBe(text);
  });

  it("never writes roster values in plaintext, nor entries the text never mentioned", async () => {
    const engine = await facade({ vault: openStore() });
    await engine.scope(SCOPE).pseudonymise(`${ANNA} (${ANNA_EMAIL})`, "pseudonymise");
    await engine.close();

    expect(rawRows().length).toBeGreaterThan(0);
    for (const value of [ANNA, ANNA_SHORT, ANNA_EMAIL, LINA, NORTHSTAR, "contact-1", "org-7"]) {
      expect(rawBytesContain(value)).toBe(false);
    }
    // Decrypted, the store holds only mappings minted for this text: the roster itself is not stored.
    const store = openStore();
    try {
      const values = new Set((await store.load(SCOPE)).map((entry) => entry.value));
      expect(values.has(LINA)).toBe(false);
      expect(values.has(NORTHSTAR)).toBe(false);
      expect(values.has(ANNA)).toBe(true);
      expect(await store.load("some-other-scope")).toEqual([]);
    } finally {
      await store.close();
    }
  });
});

describe("roster: stateless redactMany", () => {
  it("replaces roster forms with unlinked literal tokens and keeps nothing", async () => {
    // The detector also reports the roster names as persons, which the scrub profile destroys.
    const engine = await facade({ vault: openStore() });
    const { texts, items } = await engine.redactMany(
      [`${ANNA} wrote`, `${ANNA_SHORT} via ${ANNA_EMAIL}`, `${UNREGISTERED} wrote`],
      "scrub",
    );
    expect(texts[2]).toBe("[REDACTED_PERSON] wrote");
    expect(items[0]?.destroyed).toBe(0);
    expect(items[1]?.destroyed).toBe(0);
    for (const text of texts.slice(0, 2)) {
      expect(text).not.toContain(ANNA_SHORT);
      expect(text).not.toContain(ANNA_EMAIL);
      expect(entityTokens(text)).toHaveLength(0); // entity families are rendered in keyed scopes only
    }
    expect(texts[0]).toMatch(/^FICTA_PERSON_[0-9a-f]{32} wrote$/);
    expect(texts[1]).toMatch(/^FICTA_PERSON_[0-9a-f]{32} via FICTA_PERSON_[0-9a-f]{32}$/);
    // Registered names keep surrogates even under a destroy disposition; nothing is persisted.
    expect(texts.slice(0, 2).join(" ")).not.toContain("[REDACTED_PERSON]");
    await engine.close();
    expect(rawRows()).toHaveLength(0);
  });
});

describe("roster: fingerprint", () => {
  it("is stable across order, changes with any entry, and reveals no names", async () => {
    const a = await facade();
    const b = await facade({ roster: [...ROSTER].reverse() });
    const changed = await facade({
      roster: ROSTER.map((entry) => (entry.id === "contact-2" ? { ...entry, forms: ["Lina", "L. Lind"] } : entry)),
    });
    const otherKey = await facade({ surrogateKey: OTHER_SURROGATE_KEY });
    const empty = await facade({ roster: [] });

    expect(a.rosterFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.rosterFingerprint).toBe(a.rosterFingerprint);
    expect(changed.rosterFingerprint).not.toBe(a.rosterFingerprint);
    expect(otherKey.rosterFingerprint).not.toBe(a.rosterFingerprint);
    expect(empty.rosterFingerprint).not.toBe(a.rosterFingerprint);
    expect(empty.rosterSize).toBe(0);
    expect(a.rosterSize).toBe(3);
  });
});
