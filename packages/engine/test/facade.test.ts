import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine,
  type CreateEngineOptions,
  type FictaEngine,
  InvalidEngineConfigError,
  MissingSurrogateKeyError,
  RedactionUnavailableError,
  UnknownProfileError,
} from "../src/index.js";
import { openSqliteVaultStore, type SqliteVaultStore } from "../src/sqlite.js";
import type { VaultEntry, VaultStore } from "../src/vault-store.js";

// The library facade over a Presidio stand-in: a destroy-only "rules" pass and a reversible
// "pseudonymise" pass, both fail-closed, sharing one surrogate key and one vault.

const SURROGATE_KEY = "facade-test-surrogate-key-at-least-32-bytes";
const ENCRYPTION_KEY = "c3".repeat(32); // 64 hex characters = 32 bytes, distinct from the surrogate key
const SCOPE = "owner";
const CARD = "4111 1111 1111 1111";
const ACCOUNT = "40217733";
const EMAIL = "pat.example@example.com";
const PERSON = "Alex Rivera";
const OTHER_PERSON = "Sam Okafor";
// Built at runtime so no secret-shaped literal sits in the source.
const PASSWORD = ["Plum", "Kettle", "93!"].join("-");
const TOKEN = /FICTA_[A-Z0-9_]*[0-9a-f]{8,}/g;

type Span = { entity_type: string; start: number; end: number; score: number };
type Mode = "ok" | "http_500" | "slow" | "bad_json";

/**
 * A Presidio stand-in. Like the real analyzer it sees one text per request, so the context rule
 * (an 8-digit number is a bank account only when "account" appears in the same text) can never
 * leak between items. `failOn` fails just the requests whose text contains that marker.
 */
let stub: {
  server: Server;
  url: string;
  mode: Mode;
  failOn?: string;
  requests: { text: string; entities?: string[] }[];
};
let deadUrl: string;

function spansFor(text: string): Span[] {
  const spans: Span[] = [];
  const add = (entity_type: string, value: string, score = 1) => {
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
      spans.push({ entity_type, start: at, end: at + value.length, score });
    }
  };
  for (const name of [PERSON, OTHER_PERSON]) add("PERSON", name, 0.85);
  for (const match of text.matchAll(/[\w.]+@[\w.]+\.\w+/g)) add("EMAIL_ADDRESS", match[0]);
  add("CREDIT_CARD", CARD);
  if (/\baccount\b/i.test(text)) for (const match of text.matchAll(/\b\d{8}\b/g)) add("US_BANK_NUMBER", match[0], 0.9);
  return spans;
}

beforeAll(async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as { text: string; entities?: string[] };
      stub.requests.push(payload);
      const fail = stub.mode !== "ok" || (stub.failOn !== undefined && payload.text.includes(stub.failOn));
      const mode = stub.mode === "ok" && fail ? "http_500" : stub.mode;
      if (mode === "http_500") {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      if (mode === "bad_json") {
        res.setHeader("content-type", "application/json");
        res.end("{not json");
        return;
      }
      const respond = () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(spansFor(payload.text)));
      };
      if (mode === "slow") setTimeout(respond, 1_000);
      else respond();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  stub = { server, url: `http://127.0.0.1:${port}`, mode: "ok", requests: [] };

  // A port that was just free: nothing listens there.
  const closed = createServer();
  const closedPort = await new Promise<number>((resolve) => {
    closed.listen(0, "127.0.0.1", () => resolve((closed.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  deadUrl = `http://127.0.0.1:${closedPort}`;
});

afterAll(async () => {
  stub.server.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

let dir: string;
let path: string;
const engines: FictaEngine[] = [];

beforeEach(() => {
  stub.mode = "ok";
  stub.failOn = undefined;
  stub.requests = [];
  dir = mkdtempSync(join(tmpdir(), "ficta-facade-"));
  path = join(dir, "vault.db");
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROFILES: CreateEngineOptions["profiles"] = {
  rules: {
    entities: ["CREDIT_CARD", "US_BANK_NUMBER"],
    destroy: {
      categories: ["credit-card", "us-bank-number", "password-label"],
      labels: { "us-bank-number": "[REDACTED_ACCOUNT]", "password-label": "[REDACTED_SECRET]" },
    },
  },
  pseudonymise: { entities: ["PERSON", "EMAIL_ADDRESS"], secretShapes: false },
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
    ...opts,
  });
  engines.push(engine);
  return engine;
}

/** Wrap a store, counting appends and optionally failing an operation. */
function instrumented(
  backing: VaultStore,
  fail: { append?: boolean; load?: boolean } = {},
): VaultStore & { appended: VaultEntry[] } {
  const appended: VaultEntry[] = [];
  return {
    appended,
    load: (scope) => (fail.load ? Promise.reject(new Error("database is locked")) : backing.load(scope)),
    lookup: (scope, tokens) => backing.lookup(scope, tokens),
    append: async (scope, entries) => {
      if (fail.append) throw new Error("disk full");
      appended.push(...entries);
      await backing.append(scope, entries);
    },
    touch: (scope, tokens, at) => backing.touch(scope, tokens, at),
    prune: (opts) => backing.prune(opts),
    forget: (value, opts) => backing.forget(value, opts),
    close: () => backing.close(),
  };
}

async function rejection(promise: Promise<unknown>): Promise<RedactionUnavailableError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RedactionUnavailableError);
  return err as RedactionUnavailableError;
}

function expectValuesFree(err: Error, texts: readonly string[]): void {
  for (const text of texts) {
    for (const word of text.split(/\s+/).filter((w) => w.length >= 4)) expect(err.message).not.toContain(word);
  }
}

describe("createEngine: two profiles over Presidio", () => {
  it("destroys with the rules profile, then pseudonymises and restores with the other", async () => {
    const engine = await facade({ vault: openStore() });
    const input = [
      `${PERSON} paid with ${CARD}, account ${ACCOUNT}; password: ${PASSWORD}`,
      `Reply to ${EMAIL} about the order.`,
    ];

    const pass1 = await engine.redactMany(input, "rules");
    expect(pass1.texts[0]).toBe(
      `${PERSON} paid with [REDACTED_CREDIT_CARD], account [REDACTED_ACCOUNT]; password: [REDACTED_SECRET]`,
    );
    // The rules profile's entity allowlist also drops the regex floor's email finding.
    expect(pass1.texts[1]).toBe(input[1]);
    expect(pass1.items[0]).toEqual({
      text: pass1.texts[0],
      count: 3,
      destroyed: 3,
      hits: expect.arrayContaining([
        expect.objectContaining({ name: "credit-card", disposition: "destroy" }),
        expect.objectContaining({ name: "us-bank-number", disposition: "destroy" }),
        expect.objectContaining({ name: "password-label", disposition: "destroy" }),
      ]),
    });
    expect(pass1.items[1]).toEqual({ text: input[1], count: 0, destroyed: 0, hits: [] });
    // Presidio was asked once per item, with the profile's allowlist.
    expect(stub.requests.map((r) => r.entities)).toEqual([
      ["CREDIT_CARD", "US_BANK_NUMBER"],
      ["CREDIT_CARD", "US_BANK_NUMBER"],
    ]);

    const scope = engine.scope(SCOPE);
    const pass2 = await scope.pseudonymiseMany(pass1.texts, "pseudonymise");
    expect(pass2.texts[0]).not.toContain(PERSON);
    expect(pass2.texts[0]).toContain("[REDACTED_CREDIT_CARD]");
    expect(pass2.texts[1]).not.toContain(EMAIL);
    expect(pass2.items.map((item) => item.hits.map((hit) => [hit.name, hit.disposition]))).toEqual([
      [["person", "surrogate"]],
      [["email-address", "surrogate"]],
    ]);
    expect(JSON.stringify(pass2.items.map((item) => item.hits))).not.toMatch(/Rivera|example\.com|FICTA_/);

    for (const [i, text] of pass2.texts.entries()) {
      const restored = await scope.restore(text);
      expect(restored.text).toBe(pass1.texts[i]);
      expect(restored.unknownCount).toBe(0);
    }
  });

  it("redactMany isolates items: a context word in one text does not reach the next", async () => {
    const engine = await facade();
    const result = await engine.redactMany(
      [`Pay account ${ACCOUNT} today`, `Ref ${ACCOUNT} attached`, `Order 7731 ships Monday`],
      "rules",
    );
    expect(result.texts).toEqual([
      "Pay account [REDACTED_ACCOUNT] today",
      `Ref ${ACCOUNT} attached`,
      "Order 7731 ships Monday",
    ]);
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[1]?.text).not.toContain("account");
  });

  it("redactMany keeps nothing: a value found in one call is not redacted in the next", async () => {
    const store = instrumented(openStore());
    const engine = await facade({ vault: store });
    const first = await engine.redactMany([`Hi ${PERSON}`], "pseudonymise");
    expect(first.texts[0]).not.toContain(PERSON);
    expect(store.appended).toHaveLength(0);
  });

  it("uses the same token for a value whichever profile or engine instance minted it", async () => {
    const profiles = { ...PROFILES, people: { entities: ["PERSON"], secretShapes: false } };
    const a = await facade({ profiles });
    const b = await facade({ profiles });
    const [viaA] = (await a.scope(SCOPE).pseudonymiseMany([`to ${PERSON}`], "pseudonymise")).texts;
    const [viaPeople] = (await a.scope(SCOPE).pseudonymiseMany([`to ${PERSON}`], "people")).texts;
    const [viaB] = (await b.scope(SCOPE).pseudonymiseMany([`to ${PERSON}`], "pseudonymise")).texts;
    expect(viaA).toMatch(TOKEN);
    expect(viaPeople).toBe(viaA);
    expect(viaB).toBe(viaA);
  });

  it("without a vault, any profile's tokens restore within the engine", async () => {
    const engine = await facade();
    const scope = engine.scope(SCOPE);
    const { text } = await scope.pseudonymise(`mail ${EMAIL} for ${PERSON}`, "pseudonymise");
    expect(await scope.restore(text)).toEqual({
      text: `mail ${EMAIL} for ${PERSON}`,
      restoredCount: 2,
      unknownCount: 0,
    });
  });

  it("is idempotent: redacting its own output changes nothing", async () => {
    const engine = await facade();
    const input = [`${PERSON} paid ${CARD}`, `account ${ACCOUNT} for ${EMAIL}`];
    const once = await engine.redactMany(input, "rules");
    expect((await engine.redactMany(once.texts, "rules")).texts).toEqual(once.texts);

    const scope = engine.scope(SCOPE);
    const pseudo = await scope.pseudonymiseMany(once.texts, "pseudonymise");
    expect((await scope.pseudonymiseMany(pseudo.texts, "pseudonymise")).texts).toEqual(pseudo.texts);
    expect((await engine.redactMany(pseudo.texts, "rules")).texts).toEqual(pseudo.texts);
  });
});

describe("fail-closed", () => {
  const items = [`${PERSON} paid ${CARD}`, `Reply to ${EMAIL}`];

  it("an unreachable Presidio fails the batch as unreachable", async () => {
    const engine = await facade({ presidio: { url: deadUrl } });
    const err = await rejection(engine.redactMany(items, "rules"));
    expect(err.reason).toBe("unreachable");
    expect(err.detector).toBe("presidio");
    expect(err.item).toBe(0);
    expectValuesFree(err, items);
  });

  it("a Presidio 500 fails as http_error", async () => {
    stub.mode = "http_500";
    const engine = await facade();
    const err = await rejection(engine.scope(SCOPE).pseudonymiseMany(items, "pseudonymise"));
    expect(err.reason).toBe("http_error");
    expect(err.detector).toBe("presidio");
    expectValuesFree(err, items);
  });

  it("a slow Presidio fails as timeout", async () => {
    stub.mode = "slow";
    const engine = await facade({ presidio: { url: stub.url, timeoutMs: 100 } });
    const err = await rejection(engine.scope(SCOPE).pseudonymise(items[0] as string, "pseudonymise"));
    expect(err.reason).toBe("timeout");
    expect(err.item).toBeUndefined();
  });

  it("a malformed Presidio response fails as bad_response", async () => {
    stub.mode = "bad_json";
    const engine = await facade();
    expect((await rejection(engine.redactMany(items, "rules"))).reason).toBe("bad_response");
  });

  it("a batch is all or nothing: one failing item fails the call and returns no text", async () => {
    stub.failOn = "FAIL-ITEM";
    const engine = await facade();
    const batch = [`first ${CARD}`, "second FAIL-ITEM", `third ${CARD}`];
    const err = await rejection(engine.redactMany(batch, "rules"));
    expect(err.reason).toBe("http_error");
    expect(err.item).toBe(1);
    expectValuesFree(err, batch);
    const scoped = await rejection(engine.scope(SCOPE).pseudonymiseMany(batch, "pseudonymise"));
    expect(scoped.item).toBe(1);
  });

  it("without a sidecar, the regex floor and secret shapes still apply", async () => {
    // No sidecar configured is not an outage: the in-process detectors run as usual.
    const engine = await facade({ presidio: undefined });
    const { texts } = await engine.redactMany([`card ${CARD}`], "rules");
    expect(texts).toEqual(["card [REDACTED_CREDIT_CARD]"]);
  });

  it("a vault append failure fails as store_error", async () => {
    const engine = await facade({ vault: instrumented(openStore(), { append: true }) });
    const err = await rejection(engine.scope(SCOPE).pseudonymiseMany([`Hi ${PERSON}`], "pseudonymise"));
    expect(err.reason).toBe("store_error");
    expectValuesFree(err, [`Hi ${PERSON}`]);
  });

  it("a vault read failure on restore fails as store_error", async () => {
    const writer = await facade({ vault: openStore() });
    const { text } = await writer.scope(SCOPE).pseudonymise(`Hi ${PERSON}`, "pseudonymise");
    const reader = await facade({ vault: instrumented(openStore(), { load: true }) });
    expect((await rejection(reader.scope(SCOPE).restore(text))).reason).toBe("store_error");
  });
});

describe("shared SQLite vault across processes", () => {
  it("A pseudonymises, B (a separate engine on the same file) restores with counts", async () => {
    const a = await facade({ vault: openStore() });
    const { texts } = await a.scope(SCOPE).pseudonymiseMany([`${PERSON} wrote to ${EMAIL}`], "pseudonymise");
    const text = texts[0] as string;

    const b = await facade({ vault: openStore() });
    const invented = "FICTA_PERSON_" + "0".repeat(16);
    expect(await b.scope(SCOPE).restore(`${text} cc ${invented}`, { unknownToken: "[unrecognised]" })).toEqual({
      text: `${PERSON} wrote to ${EMAIL} cc [unrecognised]`,
      restoredCount: 2,
      unknownCount: 1,
    });
    // Another scope key cannot restore A's tokens.
    expect((await b.scope("someone-else").restore(text)).unknownCount).toBe(2);
  });

  it("a pruned token restores as the placeholder and counts as unknown", async () => {
    const store = openStore();
    const a = await facade({ vault: store });
    const { text } = await a.scope(SCOPE).pseudonymise(`for ${PERSON}`, "pseudonymise");
    expect(await store.prune({ notUsedSince: new Date(Date.now() + 60_000) })).toBeGreaterThan(0);

    const b = await facade({ vault: openStore() });
    expect(await b.scope(SCOPE).restore(text, { unknownToken: "[gone]" })).toEqual({
      text: "for [gone]",
      restoredCount: 0,
      unknownCount: 1,
    });
  });

  it("destroyed values never reach the store, and a destroy-only profile appends nothing", async () => {
    const store = instrumented(openStore());
    const mixedProfile = {
      entities: ["PERSON", "CREDIT_CARD"],
      secretShapes: false,
      destroy: { categories: ["credit-card"] },
    };
    const engine = await facade({ vault: store, profiles: { ...PROFILES, mixed: mixedProfile } });
    const text = `card ${CARD}, account ${ACCOUNT}, password: ${PASSWORD}`;
    const scope = engine.scope(SCOPE);

    const destroyed = await scope.pseudonymise(text, "rules");
    expect(destroyed.destroyed).toBe(3);
    expect(destroyed.text).not.toMatch(TOKEN);
    expect(store.appended).toHaveLength(0);
    await engine.redactMany([text], "rules");
    expect(store.appended).toHaveLength(0);

    // A profile that both destroys and surrogates stores the person, never the card.
    const mixed = await scope.pseudonymise(`${PERSON} paid with ${CARD}`, "mixed");
    expect(mixed.text).toMatch(/^FICTA_\S+ paid with \[REDACTED_CREDIT_CARD\]$/);
    expect(mixed).toMatchObject({ count: 2, destroyed: 1 });
    const reader = openStore();
    const stored = await reader.load(SCOPE);
    await reader.close();
    expect(stored.map((entry) => entry.value)).toContain(PERSON);
    for (const secret of [CARD, ACCOUNT, PASSWORD]) {
      expect(stored.some((entry) => entry.value.includes(secret))).toBe(false);
      expect(store.appended.some((entry) => JSON.stringify(entry).includes(secret))).toBe(false);
    }
  });
});

describe("validation and helpers", () => {
  it("requires a surrogate key", async () => {
    await expect(createEngine({ surrogateKey: "", profiles: PROFILES })).rejects.toBeInstanceOf(
      MissingSurrogateKeyError,
    );
    await expect(createEngine({ profiles: PROFILES } as unknown as CreateEngineOptions)).rejects.toBeInstanceOf(
      MissingSurrogateKeyError,
    );
  });

  it("rejects malformed profiles at creation", async () => {
    const bad: Array<Partial<CreateEngineOptions>> = [
      { profiles: {} },
      { profiles: { p: { destroy: { categories: ["credit-card"], labels: { "credit-card": "FICTA_X" } } } } },
      { profiles: { p: { destroy: { categories: ["credit-card"], labels: { email: "[X]" } } } } },
      { profiles: { p: { entities: [] } } },
      { profiles: { p: { entities: ["not a type"] } } },
      { detection: { entityPriority: ["Not A Category!"] } },
    ];
    for (const opts of bad) {
      await expect(createEngine({ surrogateKey: SURROGATE_KEY, profiles: PROFILES, ...opts })).rejects.toBeInstanceOf(
        InvalidEngineConfigError,
      );
    }
  });

  it("reports an engine-wide setting without a profile prefix", async () => {
    await expect(
      createEngine({ surrogateKey: SURROGATE_KEY, profiles: PROFILES, detection: { entityPriority: ["Bad Name!"] } }),
    ).rejects.toThrow(/^detection\.entityPriority:/);
  });

  it("an EMAIL_ADDRESS allowlist keeps the regex floor's email findings without a sidecar", async () => {
    const engine = await facade({ presidio: undefined });
    const { text, hits } = await engine.scope(SCOPE).pseudonymise(`mail ${EMAIL}`, "pseudonymise");
    expect(text).not.toContain(EMAIL);
    expect(hits).toEqual([{ name: "email", kind: "pii", disposition: "surrogate" }]);
  });

  it("names an unknown profile at call time", async () => {
    const engine = await facade();
    await expect(engine.redactMany(["x"], "missing")).rejects.toBeInstanceOf(UnknownProfileError);
    await expect(engine.scope(SCOPE).pseudonymise("x", "toString")).rejects.toThrow(/unknown redaction profile/);
    expect(engine.profiles).toEqual(["rules", "pseudonymise"]);
  });

  it("truncates without cutting a token or marker", async () => {
    const engine = await facade();
    const { text } = await engine
      .scope(SCOPE)
      .pseudonymise(`Dear ${PERSON}, your card ${CARD} is fine`, "pseudonymise");
    const token = text.match(TOKEN)?.[0] as string;
    const tokenStart = text.indexOf(token);
    const cut = engine.truncate(text, tokenStart + 5, { boundary: "word", ellipsis: "…" });
    expect(cut).toBe(`Dear…`);
    expect(engine.truncate(text, text.length)).toBe(text);
    const marked = "card [REDACTED_CREDIT_CARD] ok";
    expect(engine.truncate(marked, 12)).toBe("card ");
  });

  it("close is idempotent, closes the store, and later calls fail", async () => {
    let closes = 0;
    const store = openStore();
    const engine = await createEngine({
      surrogateKey: SURROGATE_KEY,
      profiles: PROFILES,
      vault: { ...instrumented(store), close: async () => void closes++ },
    });
    await engine.close();
    await engine.close();
    expect(closes).toBe(1);
    await store.close();
    await expect(engine.redactMany(["x"], "rules")).rejects.toThrow(/closed/);
  });

  it("restore does not proceed when close runs while it awaits the store", async () => {
    const store = openStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = await createEngine({
      surrogateKey: SURROGATE_KEY,
      profiles: PROFILES,
      vault: {
        ...instrumented(store),
        load: async (scope) => {
          await gate;
          return store.load(scope);
        },
        // Keep the backing store open so only the facade's own closed check can stop restore.
        close: async () => {},
      },
    });
    const pending = engine.scope("owner").restore("nothing to restore");
    await engine.close();
    release();
    await expect(pending).rejects.toThrow(/closed/);
    await store.close();
  });
});
