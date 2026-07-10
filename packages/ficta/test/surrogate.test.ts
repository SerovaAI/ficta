import { describe, expect, it } from "vitest";
import { hexSurrogateStrategy, surrogateStrategy, typedSurrogateStrategy } from "../src/engine/surrogate.js";
import { Vault } from "../src/engine/vault.js";

const KEY = "test-surrogate-key-at-least-32-bytes-long!!";
const OPAQUE = /^FICTA_[0-9a-f]{32}$/;
const TYPED = /^FICTA_[A-Z0-9]{1,12}_[0-9a-f]{32}$/;

describe("surrogateStrategy factory", () => {
  it("defaults to the opaque FICTA_<hex> token", () => {
    const token = surrogateStrategy({}, KEY).mint("value", { name: "person", kind: "pii" });
    expect(token).toMatch(OPAQUE);
  });

  it("selects typed surrogates when FICTA_SURROGATE_STYLE=typed", () => {
    const token = surrogateStrategy({ FICTA_SURROGATE_STYLE: "typed" }, KEY).mint("value", {
      name: "person",
      kind: "pii",
    });
    expect(token).toBe(`FICTA_PERSON_${hexTail(token)}`);
  });

  it("opaque strategy ignores the hint entirely", () => {
    const s = hexSurrogateStrategy(KEY);
    expect(s.mint("value", { name: "us-ssn", kind: "pii" })).toMatch(OPAQUE);
  });
});

describe("typedSurrogateStrategy", () => {
  const s = typedSurrogateStrategy(KEY);

  it("maps detector categories to a short, model-legible type", () => {
    expect(typeOf(s.mint("x", { name: "us-ssn", kind: "pii" }))).toBe("SSN");
    expect(typeOf(s.mint("x", { name: "person", kind: "pii" }))).toBe("PERSON");
    expect(typeOf(s.mint("x", { name: "phone-number", kind: "pii" }))).toBe("PHONE");
    expect(typeOf(s.mint("x", { name: "credit-card", kind: "pii" }))).toBe("CARD");
    expect(typeOf(s.mint("x", { name: "document-id", kind: "pii" }))).toBe("ID");
  });

  it("falls back to the coarse kind for unmapped categories", () => {
    expect(typeOf(s.mint("x", { name: "au-abn", kind: "pii" }))).toBe("PII");
    expect(typeOf(s.mint("x", { name: "some-token", kind: "secret" }))).toBe("SECRET");
    expect(typeOf(s.mint("x", {}))).toBe("REDACTED");
  });

  it("never leaks an arbitrary label (e.g. an env-var name) into the token", () => {
    const token = s.mint("x", { name: "STRIPE_SECRET_KEY", kind: "secret" });
    expect(token).toMatch(TYPED);
    expect(typeOf(token)).toBe("SECRET");
    expect(token).not.toContain("STRIPE");
  });

  it("is deterministic for a given (value, hint) and keeps the hex keyed to the value", () => {
    const a = s.mint("john@example.com", { name: "email-address", kind: "pii" });
    const b = s.mint("john@example.com", { name: "email-address", kind: "pii" });
    expect(a).toBe(b);
    // Same value, different type segment, but the hex tail is value-keyed and identical.
    const asPerson = s.mint("john@example.com", { name: "person", kind: "pii" });
    expect(hexTail(asPerson)).toBe(hexTail(a));
  });

  it("pattern matches minted tokens of any type and ignores plain prose", () => {
    const token = s.mint("x", { name: "person", kind: "pii" });
    expect(new RegExp(s.pattern).test(token)).toBe(true);
    expect(new RegExp(s.pattern).test("just some FICTA text, not a token")).toBe(false);
  });

  it("recognizes partial tokens as potential streaming prefixes, and rejects non-prefixes", () => {
    for (const prefix of ["F", "FICTA", "FICTA_", "FICTA_PER", "FICTA_PERSON_", "FICTA_PERSON_ab12"]) {
      expect(s.isPotentialPrefix(prefix)).toBe(true);
    }
    expect(s.isPotentialPrefix("hello")).toBe(false); // unrelated text
    expect(s.isPotentialPrefix("FICTA_person_ab")).toBe(false); // lowercase type is not valid
    expect(s.isPotentialPrefix("")).toBe(false);
  });
});

describe("vault with typed surrogates end to end", () => {
  it("redacts to a typed token and restores the original value", () => {
    const ssn = "123-45-6789";
    const vault = new Vault([{ value: ssn, name: "us-ssn", kind: "pii" }], typedSurrogateStrategy(KEY));

    const { text: redacted, count } = vault.redactText(JSON.stringify({ note: `SSN is ${ssn}` }));
    expect(count).toBe(1);
    expect(redacted).not.toContain(ssn);
    expect(redacted).toMatch(/FICTA_SSN_[0-9a-f]{32}/);

    expect(vault.restoreText(redacted)).toContain(ssn);
    expect(vault.leakCount(redacted)).toBe(0);
  });

  it("honors FICTA_SURROGATE_STYLE via the default Vault strategy (the engine's path)", () => {
    const saved = process.env.FICTA_SURROGATE_STYLE;
    process.env.FICTA_SURROGATE_STYLE = "typed";
    try {
      const email = "jane@example.com";
      // No explicit strategy — exactly how engine.ts constructs the vault.
      const vault = new Vault([{ value: email, name: "email-address", kind: "pii" }]);
      const { text: redacted } = vault.redactText(JSON.stringify({ to: email }));
      expect(redacted).toMatch(/FICTA_EMAIL_[0-9a-f]{32}/);
      expect(vault.restoreText(redacted)).toContain(email);
    } finally {
      if (saved === undefined) delete process.env.FICTA_SURROGATE_STYLE;
      else process.env.FICTA_SURROGATE_STYLE = saved;
    }
  });
});

// --- helpers ---------------------------------------------------------------

/** The `<TYPE>` segment of a typed token `FICTA_<TYPE>_<hex>`. */
function typeOf(token: string): string {
  return token.slice("FICTA_".length, token.lastIndexOf("_"));
}

/** The 32-hex tail of a token. */
function hexTail(token: string): string {
  return token.slice(token.lastIndexOf("_") + 1);
}
