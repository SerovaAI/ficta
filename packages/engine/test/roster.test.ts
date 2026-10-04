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
  // An entity type no profile in this file names: stands in for a category a backend adds later.
  for (const match of text.matchAll(/\bREF-\d{4}-[A-Z]{2}\b/g)) {
    spans.push({ entity_type: "CASE_REFERENCE", start: match.index, end: match.index + match[0].length, score: 0.9 });
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
    // The shared first name stays registered, as an unlinked literal token.
    expect(result.text).not.toMatch(/\bAnna\b/);
    expect(result.text.match(LITERAL_TOKEN)).toHaveLength(1);
  });

  it("keeps an ambiguous form protected without detection: unlinked, whole-word, restorable", async () => {
    stub.persons = [];
    const engine = await facade({ roster: SHARED });
    const scope = engine.scope(SCOPE);
    const result = await scope.pseudonymise(`${ANNA_SHORT} left. Annabel stayed.`, "pseudonymise");
    const [literal] = result.text.match(LITERAL_TOKEN) ?? [];
    expect(result.text).toBe(`${literal} left. Annabel stayed.`);
    expect(entityTokens(result.text)).toHaveLength(0);
    expect((await scope.restore(result.text)).text).toBe(`${ANNA_SHORT} left. Annabel stayed.`);
    // Batch (unkeyed) redaction protects it too.
    const batch = await engine.redactMany([`${ANNA_SHORT} left.`], "pseudonymise");
    expect(batch.texts[0]).not.toMatch(/\bAnna\b/);
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

  it("names the entry that owns the canonical name when earlier entries claim it only as a form", async () => {
    const roster: RosterEntry[] = [
      { id: "contact-1", type: "person", canonical: LINA, forms: [ANNA] },
      { id: "contact-2", type: "person", canonical: "Mira Holt", forms: [ANNA] },
      { id: "contact-3", type: "person", canonical: ANNA },
    ];
    const err = await facade({ roster }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidEngineConfigError);
    expect((err as Error).message).toMatch(/^roster\[0\]: .*roster\[2\]'s canonical name/);
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
    expect(items[0]?.hits).toEqual([{ name: "person", kind: "pii", disposition: "surrogate", roster: true }]);
    expect(items[2]?.hits.some((hit) => hit.roster)).toBe(false);
    await engine.close();
    expect(rawRows()).toHaveLength(0);
  });

  it("warns once, values-free, that roster tokens from redactMany cannot be restored", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const engine = await facade({ onWarn: (fields, message) => warnings.push({ fields, message }) });
    await engine.redactMany([`${UNREGISTERED} wrote`], "pseudonymise");
    expect(warnings).toEqual([]);
    const { texts } = await engine.redactMany([`${ANNA} wrote`, "nothing here", `${ANNA_SHORT} too`], "pseudonymise");
    await engine.redactMany([`${LINA} wrote`], "pseudonymise");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ profile: "pseudonymise", items: 2 });
    expect(warnings[0]?.message).toContain("cannot be restored");
    expect(JSON.stringify(warnings).toLowerCase()).not.toMatch(/anna|lina/);
    expect((await engine.scope(SCOPE).restore(texts.join(" "))).unknownCount).toBe(2);
  });
});

describe("roster: two-pass flow (destroy everything detected, then pseudonymise)", () => {
  const TWO_PASS: CreateEngineOptions["profiles"] = {
    rules: { secretShapes: false, destroy: { categories: "*" } },
    pseudonymise: { entities: ["PERSON", "EMAIL_ADDRESS"], secretShapes: false },
  };
  const REF = "REF-4412-QQ";
  const OTHER_EMAIL = "someone.else@example.org";
  const TEXTS = [
    `${ANNA} (${ANNA_EMAIL}) met ${UNREGISTERED}, case ${REF}.`,
    `${ANNA_SHORT} copied ${OTHER_EMAIL} and ${LINA}.`,
  ];

  it("keeps only roster names as linked, restorable tokens and never persists a detector finding", async () => {
    const engine = await facade({ vault: openStore(), profiles: TWO_PASS });
    const scope = engine.scope(SCOPE);
    const pass1 = await scope.pseudonymiseMany(TEXTS, "rules");
    const pass2 = await scope.pseudonymiseMany(pass1.texts, "pseudonymise");
    expect(pass2.texts).toEqual(pass1.texts); // nothing left for pass 2 to find

    const [first, second] = pass1.texts;
    expect(first).toMatch(/\(FICTA_PERSON_\S+\) met \[REDACTED_PERSON\], case \[REDACTED_CASE_REFERENCE\]\.$/);
    expect(second).toMatch(/ copied \[REDACTED_EMAIL(?:_ADDRESS)?\] and FICTA_PERSON_\S+\.$/);
    // Four roster surfaces from two entries: three share one entity tag (the canonical name, its
    // email and the short form), the fourth has its own.
    const surfacesByEntity = new Map<string, number>();
    for (const t of entityTokens(`${first} ${second}`)) {
      surfacesByEntity.set(t.entity, (surfacesByEntity.get(t.entity) ?? 0) + 1);
    }
    expect([...surfacesByEntity.values()].sort()).toEqual([1, 3]);
    await engine.close();

    // The store holds roster surfaces only: no detector finding, under any category.
    for (const value of [UNREGISTERED, REF, OTHER_EMAIL]) expect(rawBytesContain(value)).toBe(false);
    const store = openStore();
    try {
      const values = new Set((await store.load(SCOPE)).map((entry) => entry.value));
      expect(values).toEqual(new Set([ANNA, ANNA_EMAIL, ANNA_SHORT, LINA]));
    } finally {
      await store.close();
    }

    // Another process on the same file restores every roster surface; markers stay markers.
    const other = await facade({ vault: openStore(), profiles: TWO_PASS });
    const restored = await other.scope(SCOPE).restore(pass2.texts.join("\n"));
    expect(restored.unknownCount).toBe(0);
    expect(restored.restoredCount).toBe(4);
    expect(restored.text).toBe(
      [
        `${ANNA} (${ANNA_EMAIL}) met [REDACTED_PERSON], case [REDACTED_CASE_REFERENCE].`,
        `${ANNA_SHORT} copied ${second?.match(/\[REDACTED_EMAIL(?:_ADDRESS)?\]/)?.[0]} and ${LINA}.`,
      ].join("\n"),
    );
  });
});

describe("roster: two-pass flow with a narrowed rules pass", () => {
  // The rules pass names its own entity types, so a name it does not look for reaches the
  // pseudonymise pass, which tokenises it and saves it to the vault. A later rules pass in the same
  // scope must not destroy that remembered name: it already has a token, so it keeps it.
  const NARROWED: CreateEngineOptions["profiles"] = {
    rules: { entities: ["EMAIL_ADDRESS"], secretShapes: false, destroy: { categories: "*" } },
    pseudonymise: { entities: ["PERSON", "EMAIL_ADDRESS"], secretShapes: false },
  };
  const TEXT = `Mail from ${UNREGISTERED} (someone.else@example.org) about lunch.`;

  async function run(engine: FictaEngine): Promise<string> {
    const scope = engine.scope(SCOPE);
    const pass1 = await scope.pseudonymiseMany([TEXT], "rules");
    const pass2 = await scope.pseudonymiseMany(pass1.texts, "pseudonymise");
    return pass2.texts[0] ?? "";
  }

  it("keeps a remembered name's token on a rerun in the same process", async () => {
    const engine = await facade({ vault: openStore(), profiles: NARROWED });
    const first = await run(engine);
    expect(first).toMatch(/^Mail from FICTA_PERSON_[0-9a-f]{32} \(\[REDACTED_EMAIL(?:_ADDRESS)?\]\) about lunch\.$/);
    expect(await run(engine)).toBe(first);
  });

  it("keeps a remembered name's token when another process reopens the vault", async () => {
    const first = await run(await facade({ vault: openStore(), profiles: NARROWED }));
    expect(first).toContain("FICTA_PERSON_");
    const engine = await facade({ vault: openStore(), profiles: NARROWED });
    const second = await run(engine);
    expect(second).toBe(first);
    const restored = await engine.scope(SCOPE).restore(second);
    expect(restored.unknownCount).toBe(0);
    expect(restored.text).toContain(UNREGISTERED);
  });

  it("keeps the token even when the rules pass detects the remembered name itself", async () => {
    const first = await run(await facade({ vault: openStore(), profiles: NARROWED }));
    const widened: CreateEngineOptions["profiles"] = {
      ...NARROWED,
      rules: { secretShapes: false, destroy: { categories: "*" } },
    };
    expect(await run(await facade({ vault: openStore(), profiles: widened }))).toBe(first);
  });
});

describe("roster: re-applying values a keyed scope already holds", () => {
  const BARE: CreateEngineOptions["profiles"] = { none: { pii: false, secretShapes: false } };
  const LATER = `Annabel and Joanna came. ${ANNA_SHORT} too.`;

  async function firstMention(engine: FictaEngine): Promise<string> {
    const { text } = await engine.scope(SCOPE).pseudonymise(`Thanks, ${ANNA_SHORT}.`, "none");
    const [token] = entityTokens(text);
    expect(text).toBe(`Thanks, ${token?.token}.`);
    return token?.token ?? "";
  }

  it("keeps short forms word-bounded and linked on later texts", async () => {
    const engine = await facade({ profiles: BARE });
    const token = await firstMention(engine);
    const { text } = await engine.scope(SCOPE).pseudonymise(LATER, "none");
    expect(text).toBe(`Annabel and Joanna came. ${token} too.`);
    expect((await engine.scope(SCOPE).restore(text)).text).toBe(LATER);
  });

  it("behaves the same in a fresh engine hydrated from the store, with or without the entry", async () => {
    const first = await facade({ vault: openStore(), profiles: BARE });
    const token = await firstMention(first);
    await first.close();

    // The same roster, and the entry removed: the scope's retained link still applies.
    for (const roster of [ROSTER, ROSTER.slice(1)]) {
      const fresh = await facade({ vault: openStore(), profiles: BARE, roster });
      const { text } = await fresh.scope(SCOPE).pseudonymise(LATER, "none");
      expect(text).toBe(`Annabel and Joanna came. ${token} too.`);
      expect((await fresh.scope(SCOPE).restore(text)).text).toBe(LATER);
      await fresh.close();
    }
    // The short form made ambiguous by a new entry: a later mention could be either person, so it
    // gets an unlinked token, still whole-word and still restorable. The old linked token restores too.
    const ambiguous = [
      ...ROSTER,
      { id: "contact-5", type: "person" as const, canonical: "Anna Lund", forms: ["Anna"] },
    ];
    const fresh = await facade({ vault: openStore(), profiles: BARE, roster: ambiguous });
    const { text } = await fresh.scope(SCOPE).pseudonymise(LATER, "none");
    const [literal] = text.match(LITERAL_TOKEN) ?? [];
    expect(text).toBe(`Annabel and Joanna came. ${literal} too.`);
    expect((await fresh.scope(SCOPE).restore(text)).text).toBe(LATER);
    expect((await fresh.scope(SCOPE).restore(`${token}`)).text).toBe("Anna");
    await fresh.close();
  });

  it("still re-applies a detected (non-roster) value as before: a literal token, matched as a substring", async () => {
    stub.persons = [UNREGISTERED];
    const engine = await facade();
    const first = await engine.scope(SCOPE).pseudonymise(`Hi ${UNREGISTERED}.`, "pseudonymise");
    const [literal] = first.text.match(LITERAL_TOKEN) ?? [];
    expect(first.text).toBe(`Hi ${literal}.`);
    stub.persons = [];
    const later = await engine.scope(SCOPE).pseudonymise(`${UNREGISTERED}s wrote.`, "pseudonymise");
    expect(later.text).toBe(`${literal}s wrote.`);
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
