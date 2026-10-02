import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  defaultDestroyLabel,
  type EngineConfigInput,
  InvalidEngineConfigError,
  piiPlugin,
  resolveEngineConfig,
  secretShapesPlugin,
} from "../src/index.js";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin, ProtectedValue } from "../src/plugins/types.js";

// The "destroy" disposition: detections of configured categories become a fixed marker instead of a
// reversible surrogate, and the raw value is never retained anywhere a later restore could reach.

const KEY = "destroy-disposition-surrogate-key-32-bytes-min";
const CARD = "4111 1111 1111 1111"; // Luhn-valid test card: the regex PII floor reports it as credit-card
const EMAIL = "pat.example@example.com";
const ID13 = "8001015009087"; // SA-ID-shaped and Luhn-valid, so the regex floor also reads it as a card
const ID13_NOT_LUHN = "8001015009088";

/** Recursively search any reachable object state (private fields, Maps, Sets) for a string. */
function stateContains(root: unknown, needle: string): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (node.includes(needle)) return true;
      continue;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node instanceof Map) {
      for (const [key, value] of node) stack.push(key, value);
      continue;
    }
    if (node instanceof Set || Array.isArray(node)) {
      for (const value of node) stack.push(value);
      continue;
    }
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key === "string" && key.includes(needle)) return true;
      stack.push((node as Record<string | symbol, unknown>)[key]);
    }
  }
  return false;
}

function fixtureDetector(name: string, findings: (text: string) => ProtectedValue[]): DetectorPlugin {
  return { kind: "detector", name, detectText: (text) => findings(text) };
}

/** Reports every occurrence of `value` under `category`. */
function valueDetector(category: string, value: string, confidence: ProtectedValue["confidence"] = "high") {
  return fixtureDetector(`fixture-${category}`, (text) =>
    text.includes(value) ? [{ name: category, value, source: "fixture", kind: "pii", confidence }] : [],
  );
}

function regexPiiEngine(config: EngineConfigInput = {}, values: ProtectedValue[] = []): ProtectionEngine {
  return new ProtectionEngine({
    plugins: [piiPlugin, secretShapesPlugin],
    values,
    config: {
      surrogate: { key: KEY, style: "typed" },
      pii: { enabled: true },
      dispositions: { destroy: { categories: ["credit-card", "password-label"] } },
      ...config,
    },
  });
}

describe("destroy disposition config", () => {
  it("is off by default", () => {
    expect(resolveEngineConfig().dispositions.destroy).toEqual({ all: false, categories: [], labels: {} });
  });

  it("normalizes categories and derives default markers", () => {
    const { destroy } = resolveEngineConfig({
      dispositions: { destroy: { categories: ["CREDIT_CARD", " one-time-code ", "credit-card"] } },
    }).dispositions;
    expect(destroy.categories).toEqual(["credit-card", "one-time-code"]);
    expect(destroy.labels).toEqual({
      "credit-card": "[REDACTED_CREDIT_CARD]",
      "one-time-code": "[REDACTED_ONE_TIME_CODE]",
    });
    expect(defaultDestroyLabel("secret-assignment")).toBe("[REDACTED_SECRET_ASSIGNMENT]");
  });

  it("lets several categories share one label", () => {
    const { destroy } = resolveEngineConfig({
      dispositions: {
        destroy: {
          categories: ["password-label", "secret-assignment"],
          labels: { "password-label": "[REDACTED_SECRET]", SECRET_ASSIGNMENT: "[REDACTED_SECRET]" },
        },
      },
    }).dispositions;
    expect(destroy.labels).toEqual({ "password-label": "[REDACTED_SECRET]", "secret-assignment": "[REDACTED_SECRET]" });
  });

  it.each([
    ["an empty label", { categories: ["email"], labels: { email: "" } }],
    ["an unbracketed label", { categories: ["email"], labels: { email: "REDACTED" } }],
    ["a label with spaces", { categories: ["email"], labels: { email: "[REDACTED EMAIL]" } }],
    ["a surrogate-shaped label", { categories: ["email"], labels: { email: "[FICTA_EMAIL]" } }],
    ["a label for an unlisted category", { categories: ["email"], labels: { person: "[REDACTED]" } }],
    ["an empty category", { categories: [""] }],
    ["a category with spaces", { categories: ["credit card"] }],
  ])("rejects %s", (_, destroy) => {
    expect(() => resolveEngineConfig({ dispositions: { destroy } })).toThrow(InvalidEngineConfigError);
    expect(() => new ProtectionEngine({ config: { surrogate: { key: KEY }, dispositions: { destroy } } })).toThrow(
      InvalidEngineConfigError,
    );
  });
});

describe("destroy disposition: content path", () => {
  it("replaces a destroy category with its marker and keeps surrogates for the rest", async () => {
    const engine = regexPiiEngine();
    const text = `Card ${CARD}, receipt to ${EMAIL}.`;

    const result = await engine.redactContentDetailed(text);

    expect(result.text).toMatch(/^Card \[REDACTED_CREDIT_CARD\], receipt to FICTA_EMAIL_[0-9a-f]+\.$/);
    expect(result.count).toBe(2);
    expect(result.destroyed).toBe(1);
    expect(result.leaks).toBe(0);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "credit-card", disposition: "destroy" }),
        expect.objectContaining({ name: "email" }),
      ]),
    );
    expect(result.hits.find((hit) => hit.name === "email")?.disposition).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(CARD);

    // The marker is inert on restore; the surrogate still restores.
    expect(engine.restoreText(result.text)).toBe(`Card [REDACTED_CREDIT_CARD], receipt to ${EMAIL}.`);
    // The destroyed value is held nowhere: not in the vault, metadata, or any scope.
    expect(stateContains(engine, CARD)).toBe(false);
    expect(stateContains(engine, EMAIL)).toBe(true); // sanity: the inspector does see vault contents
    expect(engine.containsProtectedValue(CARD)).toBe(false);
  });

  it("reports no destroyed count when nothing was destroyed", async () => {
    const result = await regexPiiEngine().redactContentDetailed(`Mail ${EMAIL}`);
    expect(result.destroyed).toBeUndefined();
    expect(result.hits.every((hit) => hit.disposition === undefined)).toBe(true);
  });

  it("uses a configured label", async () => {
    const engine = regexPiiEngine({
      dispositions: { destroy: { categories: ["credit-card"], labels: { "credit-card": "[REDACTED_CARD]" } } },
    });
    const result = await engine.redactContentDetailed(`pay with ${CARD}`);
    expect(result.text).toBe("pay with [REDACTED_CARD]");
  });

  it("is deterministic across engines and idempotent on its own output", async () => {
    const text = `password: Tr0ub4dor&3x then card ${CARD} and ${EMAIL}`;
    const first = await regexPiiEngine().redactContentDetailed(text);
    const second = await regexPiiEngine().redactContentDetailed(text);
    expect(first.text).toBe(second.text);
    expect(first.text).toContain("password: [REDACTED_PASSWORD_LABEL]");
    expect(first.text).toContain("card [REDACTED_CREDIT_CARD]");
    expect(first.destroyed).toBe(2);

    const engine = regexPiiEngine();
    const once = await engine.redactContentDetailed(text);
    const twice = await engine.redactContentDetailed(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.destroyed).toBeUndefined();
    const thrice = await regexPiiEngine().redactContentDetailed(once.text);
    expect(thrice.text).toBe(once.text);
  });

  it("passes surrogate tokens from another engine through untouched", async () => {
    const surrogating = new ProtectionEngine({
      plugins: [piiPlugin, secretShapesPlugin],
      config: { surrogate: { key: "another-surrogate-key-for-this-test-32b", style: "typed" }, pii: { enabled: true } },
    });
    const surrogated = await surrogating.redactContentDetailed(`Card ${CARD}, mail ${EMAIL}, token sk-proj-abc`);
    expect(surrogated.text).toMatch(/FICTA_/);
    const result = await regexPiiEngine().redactContentDetailed(surrogated.text);
    expect(result.text).toBe(surrogated.text);
    expect(result.count).toBe(0);
  });

  it("destroys a value detected under both a destroy and a surrogate category", async () => {
    const engine = new ProtectionEngine({
      plugins: [valueDetector("phone-number", ID13), valueDetector("za-id", ID13)],
      config: { surrogate: { key: KEY }, dispositions: { destroy: { categories: ["za-id"] } } },
    });
    const result = await engine.redactContentDetailed(`ref ${ID13}`);
    expect(result.text).toBe("ref [REDACTED_ZA_ID]");
    expect(stateContains(engine, ID13)).toBe(false);
  });
});

describe("destroy disposition: registered values", () => {
  it("registered wins: an exact registered value keeps its surrogate even when detected as a destroy category", async () => {
    const registered: ProtectedValue = {
      name: "BILLING_CARD",
      value: CARD,
      source: "fixture-registry",
      kind: "secret",
    };
    const engine = regexPiiEngine({}, [registered]);

    const result = await engine.redactContentDetailed(`Card ${CARD} on file`);

    expect(result.text).toMatch(/^Card FICTA_[A-Z_]*[0-9a-f]+ on file$/);
    expect(result.destroyed).toBeUndefined();
    expect(result.leaks).toBe(0);
    expect(engine.restoreText(result.text)).toBe(`Card ${CARD} on file`);
    // The fail-closed leak check still covers it: an unredacted copy is a leak.
    expect(engine.containsProtectedValue(`raw ${CARD}`)).toBe(true);

    const header = await engine.redactTextDetailed(`card=${CARD}`, { surface: "header" });
    expect(header.text).not.toContain(CARD);
    expect(header.destroyed).toBeUndefined();
    expect(engine.restoreText(header.text)).toBe(`card=${CARD}`);
  });

  it("a caller-selected value keeps its surrogate in a scope", async () => {
    const engine = regexPiiEngine();
    const scope = engine.beginRequest("org:thread");
    scope.registerProtectedValues([{ name: "SELECTED", value: CARD, source: "user-selected" }]);
    const result = await scope.redactContentDetailed(`Card ${CARD}`);
    expect(result.text).toMatch(/^Card FICTA_/);
    expect(scope.restoreText(result.text)).toBe(`Card ${CARD}`);
  });
});

describe("destroy disposition: overlaps", () => {
  async function presidio(spans: (text: string) => object[]): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { text } = JSON.parse(body) as { text: string };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(spans(text)));
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    return { server, url: `http://127.0.0.1:${port}` };
  }

  function close(server: Server): Promise<void> {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function presidioEngine(url: string): ProtectionEngine {
    return new ProtectionEngine({
      plugins: [piiPlugin],
      config: {
        surrogate: { key: KEY, style: "typed" },
        pii: { enabled: true, backends: ["presidio"], presidio: { url } },
        dispositions: { destroy: { categories: ["ZA_ID_NUMBER"] } },
      },
    });
  }

  it("a 13-digit ID destroyed over overlapping surrogate spans leaves no digit fragments", async () => {
    const stub = await presidio((text) => {
      const at = text.indexOf(ID13);
      if (at < 0) return [];
      return [
        { entity_type: "ZA_ID_NUMBER", start: at, end: at + 13, score: 0.95 },
        { entity_type: "PHONE_NUMBER", start: at + 3, end: at + 13, score: 0.4 },
        { entity_type: "DATE_TIME", start: at, end: at + 6, score: 0.6 },
      ];
    });
    try {
      const engine = presidioEngine(stub.url);
      const result = await engine.redactContentDetailed(`ID ${ID13} on file`);
      expect(result.text).toBe("ID [REDACTED_ZA_ID_NUMBER] on file");
      expect(result.destroyed).toBe(1);
      expect(engine.restoreText(result.text)).toBe(result.text);
      expect(stateContains(engine, ID13)).toBe(false);
    } finally {
      await close(stub.server);
    }
  });

  it("when a surrogate span outranks part of a destroyed ID, the remainder is destroyed, not left raw", async () => {
    const stub = await presidio((text) => {
      const at = text.indexOf(ID13_NOT_LUHN);
      if (at < 0) return [];
      return [
        { entity_type: "ZA_ID_NUMBER", start: at, end: at + 13, score: 0.5 },
        { entity_type: "PHONE_NUMBER", start: at + 3, end: at + 13, score: 0.95 },
      ];
    });
    try {
      const engine = presidioEngine(stub.url);
      const result = await engine.redactContentDetailed(`ID ${ID13_NOT_LUHN} on file`);
      expect(result.text).toMatch(/^ID \[REDACTED_ZA_ID_NUMBER\]FICTA_PHONE_[0-9a-f]+ on file$/);
      expect(result.text.replace(/FICTA_[A-Z_]*[0-9a-f]+/g, "")).not.toMatch(/\d/);
      expect(result.text).not.toContain(ID13_NOT_LUHN.slice(0, 3));
      expect(result.destroyed).toBe(1);
    } finally {
      await close(stub.server);
    }
  });

  it("an NER span over an existing marker does not re-redact it", async () => {
    const stub = await presidio((text) => {
      const spans: object[] = [];
      for (const word of ["[REDACTED_ZA_ID_NUMBER]", "REDACTED_ZA_ID_NUMBER", ID13]) {
        const at = text.indexOf(word);
        if (at >= 0)
          spans.push({
            entity_type: word === ID13 ? "ZA_ID_NUMBER" : "PERSON",
            start: at,
            end: at + word.length,
            score: 0.9,
          });
      }
      return spans;
    });
    try {
      const engine = presidioEngine(stub.url);
      const once = await engine.redactContentDetailed(`ID ${ID13}`);
      expect(once.text).toBe("ID [REDACTED_ZA_ID_NUMBER]");
      const twice = await engine.redactContentDetailed(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.count).toBe(0);
    } finally {
      await close(stub.server);
    }
  });
});

describe("destroy disposition: body path, scopes, headers and restore", () => {
  it("destroys every occurrence across a JSON body, including leaves the detector did not flag", async () => {
    // The detector only fires on the first message; entity expansion carries the value to the second.
    const detector = fixtureDetector("fixture-first-leaf", (text) =>
      text.startsWith("first") ? [{ name: "one-time-code", value: "731905", source: "fixture", kind: "pii" }] : [],
    );
    const engine = new ProtectionEngine({
      plugins: [{ ...detector, bodyDetectionView: "content" }],
      config: { surrogate: { key: KEY }, dispositions: { destroy: { categories: ["one-time-code"] } } },
    });
    const body = JSON.stringify({ messages: [{ content: "first code 731905" }, { content: "again 731905" }] });

    const result = await engine.redactBodyDetailed(body);

    expect(JSON.parse(result.body)).toEqual({
      messages: [{ content: "first code [REDACTED_ONE_TIME_CODE]" }, { content: "again [REDACTED_ONE_TIME_CODE]" }],
    });
    expect(result.destroyed).toBe(1);
    expect(stateContains(engine, "731905")).toBe(false);
  });

  it("keeps destroying a re-sent value in a keyed scope and never retains it", async () => {
    const detector = valueDetector("one-time-code", "731905");
    const engine = new ProtectionEngine({
      plugins: [detector],
      config: { surrogate: { key: KEY }, dispositions: { destroy: { categories: ["one-time-code"] } } },
    });
    const turn1 = JSON.stringify({ messages: [{ content: "code 731905" }] });
    const turn2 = JSON.stringify({ messages: [{ content: "code 731905" }, { content: "thanks" }] });

    const first = await engine.beginRequest("org:thread").redactBodyDetailed(turn1);
    const second = await engine.beginRequest("org:thread").redactBodyDetailed(turn2);

    expect(first.body).not.toContain("731905");
    expect(second.body).not.toContain("731905");
    expect(JSON.parse(second.body).messages[0].content).toBe("code [REDACTED_ONE_TIME_CODE]");
    expect(second.destroyed).toBe(1);
    expect(stateContains(engine, "731905")).toBe(false);
    expect(engine.beginRequest("org:thread").restoreText(second.body)).toBe(second.body);
  });

  it("destroys on the header/query text path", async () => {
    const engine = new ProtectionEngine({
      plugins: [valueDetector("one-time-code", "731905")],
      config: { surrogate: { key: KEY }, dispositions: { destroy: { categories: ["one-time-code"] } } },
    });
    const result = await engine.redactTextDetailed("otp=731905&again=731905", { surface: "header" });
    expect(result.text).toBe("otp=[REDACTED_ONE_TIME_CODE]&again=[REDACTED_ONE_TIME_CODE]");
    expect(result.count).toBe(1);
    expect(result.destroyed).toBe(1);
    expect(result.hits).toEqual([expect.objectContaining({ name: "one-time-code", disposition: "destroy" })]);
    expect(stateContains(engine, "731905")).toBe(false);
    const again = await engine.redactTextDetailed(result.text, { surface: "header" });
    expect(again.text).toBe(result.text);
  });

  it("keeps the raw value out of trace values while tracing occurrences by marker", async () => {
    const engine = regexPiiEngine();
    const result = await engine.redactContentDetailed(`Card ${CARD}`, { traceValues: true, traceOccurrences: true });
    expect(result.traceValues).toBeUndefined();
    expect(result.traceOccurrences).toEqual([
      expect.objectContaining({ name: "credit-card", disposition: "destroy", surrogate: "[REDACTED_CREDIT_CARD]" }),
    ]);
  });

  it("streams markers through restore untouched and never counts them as residual surrogates", async () => {
    const engine = regexPiiEngine();
    const scope = engine.beginRequest();
    const redacted = await scope.redactContentDetailed(`Card ${CARD}, mail ${EMAIL}`);
    const stream = new Blob([redacted.text]).stream().pipeThrough(scope.restoreStream());
    const restored = await new Response(stream).text();
    expect(restored).toBe(`Card [REDACTED_CREDIT_CARD], mail ${EMAIL}`);
    expect(scope.residualSurrogateCount).toBe(0);
    expect(scope.restoreJson(JSON.stringify({ text: redacted.text }))).toBe(
      JSON.stringify({ text: `Card [REDACTED_CREDIT_CARD], mail ${EMAIL}` }),
    );
  });
});

describe('destroy disposition: categories "*"', () => {
  it("resolves to destroy-all, with label overrides for any category", () => {
    const { destroy } = resolveEngineConfig({
      dispositions: { destroy: { categories: "*", labels: { CREDIT_CARD: "[REDACTED_CARD]" } } },
    }).dispositions;
    expect(destroy).toEqual({ all: true, categories: [], labels: { "credit-card": "[REDACTED_CARD]" } });
    const listed = resolveEngineConfig({ dispositions: { destroy: { categories: ["*"] } } }).dispositions.destroy;
    expect(listed.all).toBe(true);
  });

  it.each([
    ['"*" mixed with names', { categories: ["*", "email"] }],
    ["another bare string", { categories: "all" }],
    ["an invalid label", { categories: "*", labels: { email: "nope" } }],
  ])("rejects %s", (_, destroy) => {
    const input = { dispositions: { destroy } } as EngineConfigInput;
    expect(() => resolveEngineConfig(input)).toThrow(InvalidEngineConfigError);
  });

  it("destroys every detector category, including one no config names, and keeps registered values", async () => {
    const engine = new ProtectionEngine({
      plugins: [piiPlugin, valueDetector("future-category", "QX-7731")],
      values: [{ name: "registered", value: "registered-literal-value", source: "fixture", kind: "custom" }],
      config: {
        surrogate: { key: KEY, style: "typed" },
        pii: { enabled: true },
        dispositions: { destroy: { categories: "*", labels: { email: "[REDACTED_MAIL]" } } },
      },
    });
    const text = `Card ${CARD}, mail ${EMAIL}, code QX-7731, key registered-literal-value.`;
    const result = await engine.redactContentDetailed(text);
    expect(result.text).toMatch(
      /^Card \[REDACTED_CREDIT_CARD\], mail \[REDACTED_MAIL\], code \[REDACTED_FUTURE_CATEGORY\], key FICTA_[A-Z]+_[0-9a-f]{32}\.$/,
    );
    expect(result.destroyed).toBe(3);
    expect(result.leaks).toBe(0);
    expect(stateContains(engine, "QX-7731")).toBe(false);
    // Idempotent: default-shaped markers of any category are left alone.
    expect((await engine.redactContentDetailed(result.text)).text).toBe(result.text);
  });
});
