import { describe, expect, it } from "vitest";
import {
  entityFamilySurrogateStrategy,
  hexSurrogateStrategy,
  residualSurrogatePattern,
  typedSurrogateStrategy,
} from "../src/surrogate.js";
import { truncateRedactedText } from "../src/text.js";
import { Vault } from "../src/vault.js";

const KEY = "truncate-redacted-test-key-at-least-32-bytes!";
const HEX = hexSurrogateStrategy(KEY).mint("alice@example.com");
const TYPED = typedSurrogateStrategy(KEY).mint("alice@example.com", { name: "email" });

describe("truncateRedactedText", () => {
  it("returns text unchanged when it already fits (no ellipsis added)", () => {
    const text = `mail ${HEX} now`;
    expect(truncateRedactedText(text, text.length, { ellipsis: "…" })).toBe(text);
    expect(truncateRedactedText(text, text.length + 10, { ellipsis: "…" })).toBe(text);
  });

  it("handles empty input and non-positive limits", () => {
    expect(truncateRedactedText("", 0)).toBe("");
    expect(truncateRedactedText("", 5, { ellipsis: "…" })).toBe("");
    expect(truncateRedactedText("hello", 0, { ellipsis: "…" })).toBe("");
    expect(truncateRedactedText("hello", -3)).toBe("");
  });

  it("cuts a plain string at the limit and counts the ellipsis within it", () => {
    expect(truncateRedactedText("abcdefghij", 5)).toBe("abcde");
    expect(truncateRedactedText("abcdefghij", 5, { ellipsis: "…" })).toBe("abcd…");
    expect(truncateRedactedText("abcdefghij", 5, { ellipsis: "..." })).toBe("ab...");
  });

  it("drops an ellipsis that alone would not fit the limit", () => {
    expect(truncateRedactedText("abcdefghij", 2, { ellipsis: "..." })).toBe("ab");
  });

  it.each([
    ["opaque", HEX],
    ["typed", TYPED],
  ])("drops a %s surrogate token that straddles the limit", (_style, token) => {
    const text = `send to ${token} today`;
    const start = text.indexOf(token);
    for (let limit = start + 1; limit < start + token.length; limit++) {
      expect(truncateRedactedText(text, limit)).toBe("send to ");
    }
    expect(truncateRedactedText(text, start + token.length)).toBe(`send to ${token}`);
  });

  it("drops an entity-family token that straddles the limit", () => {
    const vault = new Vault([], entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY));
    const scope = vault.beginScope(undefined, undefined, "thread:truncate");
    const token = scope.registerResolvedEntitySurface(
      { value: "Northstar Biologics", entityId: "entity-northstar", entityType: "organization" },
      "registry",
      true,
    );
    const text = `ask ${token} first`;
    expect(truncateRedactedText(text, 4 + token.length - 1)).toBe("ask ");
    expect(truncateRedactedText(text, 4 + token.length)).toBe(`ask ${token}`);
  });

  it("moves the cut before the token when the ellipsis would land inside it", () => {
    const text = `x ${HEX} y`;
    expect(truncateRedactedText(text, 2 + HEX.length, { ellipsis: "…" })).toBe("x …");
  });

  it("drops a bracketed redaction marker that straddles the limit", () => {
    const text = "card [REDACTED_CARD] expires";
    for (let limit = 6; limit < 20; limit++) {
      expect(truncateRedactedText(text, limit)).toBe("card ");
    }
    expect(truncateRedactedText(text, 20)).toBe("card [REDACTED_CARD]");
    expect(truncateRedactedText("a [REDACTED] b", 8)).toBe("a ");
  });

  it("cuts on a word boundary when asked", () => {
    const text = "the quick brown fox";
    expect(truncateRedactedText(text, 12, { wordBoundary: true })).toBe("the quick");
    expect(truncateRedactedText(text, 12, { wordBoundary: true, ellipsis: "…" })).toBe("the quick…");
    // The limit already sits on a boundary: keep the whole word before it.
    expect(truncateRedactedText(text, 9, { wordBoundary: true })).toBe("the quick");
  });

  it("combines word boundaries with token safety", () => {
    const text = `hi ${HEX} there friend`;
    expect(truncateRedactedText(text, 3 + HEX.length + 4, { wordBoundary: true })).toBe(`hi ${HEX}`);
    expect(truncateRedactedText(text, 10, { wordBoundary: true })).toBe("hi");
  });

  it("falls back to a character cut when the limit is inside the first word", () => {
    expect(truncateRedactedText("supercalifragilistic word", 5, { wordBoundary: true })).toBe("super");
    expect(truncateRedactedText("supercalifragilistic word", 5, { wordBoundary: true, ellipsis: "…" })).toBe("supe…");
    expect(truncateRedactedText(`${HEX} rest`, 10, { wordBoundary: true })).toBe("");
  });

  it("never splits a UTF-16 surrogate pair", () => {
    const text = "ab😀cd"; // 😀 is two code units at indices 2–3
    expect(truncateRedactedText(text, 3)).toBe("ab");
    expect(truncateRedactedText(text, 4)).toBe("ab😀");
    expect(truncateRedactedText("😀😀😀", 5, { ellipsis: "…" })).toBe("😀😀…");
    expect(truncateRedactedText("naïve café", 6)).toBe("naïve ");
  });

  it("redact → truncate → restore: no fragment of a token survives any cut", () => {
    const values = ["alice@example.com", "sk-live-0123456789abcdef", "Northstar Biologics"];
    const vault = new Vault(values.map((value) => ({ value })));
    const original = `Email ${values[0]} with key ${values[1]} about ${values[2]}. 😀 [REDACTED_CARD] done.`;
    const redacted = vault.redactText(original).text;
    const tokens = new Set([...redacted.matchAll(residualSurrogatePattern())].map((match) => match[0]));
    expect(tokens.size).toBe(3);

    for (let limit = 0; limit <= redacted.length + 1; limit++) {
      for (const options of [{}, { ellipsis: "…" }, { wordBoundary: true, ellipsis: "..." }]) {
        const out = truncateRedactedText(redacted, limit, options);
        expect(out.length).toBeLessThanOrEqual(Math.max(limit, 0));
        const body = out.endsWith(options.ellipsis ?? "\0") ? out.slice(0, -(options.ellipsis?.length ?? 0)) : out;
        expect(redacted.startsWith(body)).toBe(true);

        // Every FICTA_ occurrence that survived is a whole, known token.
        const found = [...body.matchAll(residualSurrogatePattern())];
        expect(found.every((match) => tokens.has(match[0]))).toBe(true);
        expect(body.split("FICTA_").length - 1).toBe(found.length);
        // Markers are whole or absent.
        expect((body.match(/\[REDACTED/g) ?? []).length).toBe((body.match(/\[REDACTED_CARD\]/g) ?? []).length);
        // Restoring leaves no token debris, and redacting again maps back to the same text.
        const restored = vault.restoreText(body);
        expect(restored).not.toContain("FICTA_");
        expect(original.startsWith(restored)).toBe(true);
        expect(vault.redactText(restored).text).toBe(body);
      }
    }
    expect(vault.residualSurrogateCount).toBe(0);
  });
});
