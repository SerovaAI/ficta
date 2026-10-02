import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EngineConfigInput, InvalidEngineConfigError, piiPlugin, resolveEngineConfig } from "../src/index.js";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin, ProtectedValue } from "../src/plugins/types.js";

// One value, two categories: a 13-digit South African ID number ends in a Luhn check digit, so the
// regex floor's checksum-gated `credit-card` pattern (and Presidio's CreditCardRecognizer) also
// accept it. Which category wins must follow explicit config, never detector or result order.

const KEY = "category-priority-surrogate-key-32-bytes-min";

/** Append the digit that makes the number pass the Luhn checksum. */
function withLuhnCheckDigit(prefix: string): string {
  for (let check = 0; check <= 9; check++) {
    const digits = `${prefix}${check}`;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return digits;
  }
  throw new Error("unreachable");
}

// Synthetic: YYMMDD 450101, sequence 5009, citizen 0, legacy digit 8, computed check digit.
const ZA_ID = withLuhnCheckDigit("450101500908");
// Luhn-valid 13 digits whose "month" is 13: a card-shaped number, not a valid ID.
const NOT_AN_ID = withLuhnCheckDigit("451301500908");
const CARD16 = "4111 1111 1111 1111";

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

type Span = { entity_type: string; start: number; end: number; score: number };

/**
 * A Presidio stand-in. `entities` lists the types it reports for each validated ID, in response
 * order; a non-ID 13-digit number or 16-digit card is reported as CREDIT_CARD only.
 */
let stub: { server: Server; url: string; entities: string[] };

beforeAll(async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { text } = JSON.parse(body) as { text: string };
      const spans: Span[] = [];
      const at = (value: string) => text.indexOf(value);
      if (at(ZA_ID) >= 0) {
        for (const entity_type of stub.entities)
          spans.push({ entity_type, start: at(ZA_ID), end: at(ZA_ID) + 13, score: 1 });
      }
      for (const card of [NOT_AN_ID, CARD16]) {
        if (at(card) >= 0)
          spans.push({ entity_type: "CREDIT_CARD", start: at(card), end: at(card) + card.length, score: 1 });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(spans));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  stub = { server, url: `http://127.0.0.1:${port}`, entities: [] };
});

afterAll(async () => {
  stub.server.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

function engineWith(backends: string[], config: EngineConfigInput = {}): ProtectionEngine {
  return new ProtectionEngine({
    plugins: [piiPlugin],
    config: {
      surrogate: { key: KEY, style: "typed" },
      pii: { enabled: true, backends, presidio: { url: stub.url } },
      ...config,
    },
  });
}

const RESPONSE_ORDERS = [["ZA_ID_NUMBER", "CREDIT_CARD"], ["CREDIT_CARD", "ZA_ID_NUMBER"], ["ZA_ID_NUMBER"]];
const BACKEND_ORDERS = [
  ["regex", "presidio"],
  ["presidio", "regex"],
  ["presidio"], // the regex floor is still added
];
const PRIORITY = { detection: { entityPriority: ["ZA_ID_NUMBER", "credit-card"] } };

describe("category priority: a Luhn-valid ZA ID versus the card claims", () => {
  it("the generated fixtures have the intended shapes", () => {
    expect(ZA_ID).toMatch(/^\d{10}[0-2][89]\d$/);
    expect(NOT_AN_ID).toHaveLength(13);
    expect(NOT_AN_ID.slice(2, 4)).toBe("13");
  });

  for (const entities of RESPONSE_ORDERS) {
    for (const backends of BACKEND_ORDERS) {
      const label = `presidio [${entities.join(", ")}], backends [${backends.join(", ")}]`;

      it(`destroys the ID when only its category is destroyed: ${label}`, async () => {
        stub.entities = entities;
        const engine = engineWith(backends, {
          ...PRIORITY,
          dispositions: { destroy: { categories: ["za-id-number"] } },
        });
        const scope = engine.beginRequest("thread");
        const result = await scope.redactContentDetailed(`ID ${ZA_ID} on file`);

        expect(result.text).toBe("ID [REDACTED_ZA_ID_NUMBER] on file");
        expect(result.text).not.toContain("FICTA_");
        expect(result.destroyed).toBe(1);
        expect(result.hits).toEqual([expect.objectContaining({ name: "za-id-number", disposition: "destroy" })]);
        expect(scope.restoreText(result.text)).toBe(result.text);
        expect(stateContains(engine, ZA_ID)).toBe(false);
        expect(stateContains(scope, ZA_ID)).toBe(false);
      });

      it(`classifies the ID as za-id-number, not credit-card: ${label}`, async () => {
        stub.entities = entities;
        const engine = engineWith(backends, PRIORITY);
        const result = await engine.redactContentDetailed(`ID ${ZA_ID} on file`);

        expect(result.text).toMatch(/^ID FICTA_ID_[0-9a-f]+ on file$/);
        expect(result.hits).toEqual([expect.objectContaining({ name: "za-id-number" })]);
        expect(engine.restoreText(result.text)).toBe(`ID ${ZA_ID} on file`);
      });
    }
  }

  it("without a priority list the sidecar's own answer still wins over the regex floor", async () => {
    // The shipped sidecar drops CREDIT_CARD when ZA_ID_NUMBER validated the same span, so it only
    // ever answers ZA_ID_NUMBER here; the floor's card claim must not override it.
    stub.entities = ["ZA_ID_NUMBER"];
    for (const backends of BACKEND_ORDERS) {
      const engine = engineWith(backends, { dispositions: { destroy: { categories: ["za-id-number"] } } });
      const result = await engine.redactContentDetailed(`ID ${ZA_ID}`);
      expect(result.text).toBe("ID [REDACTED_ZA_ID_NUMBER]");
      expect(stateContains(engine, ZA_ID)).toBe(false);
    }
  });

  it("a Luhn-valid 13-digit number that is not a valid ID stays a credit card", async () => {
    stub.entities = ["ZA_ID_NUMBER", "CREDIT_CARD"];
    const engine = engineWith(["regex", "presidio"], {
      ...PRIORITY,
      dispositions: { destroy: { categories: ["za-id-number"] } },
    });
    const result = await engine.redactContentDetailed(`card ${NOT_AN_ID}`);
    expect(result.text).toMatch(/^card FICTA_CARD_[0-9a-f]+$/);
    expect(result.destroyed).toBeUndefined();
    expect(engine.restoreText(result.text)).toBe(`card ${NOT_AN_ID}`);
  });

  it("16-digit cards are unaffected", async () => {
    stub.entities = ["ZA_ID_NUMBER", "CREDIT_CARD"];
    const engine = engineWith(["regex", "presidio"], {
      ...PRIORITY,
      dispositions: { destroy: { categories: ["za-id-number"] } },
    });
    const result = await engine.redactContentDetailed(`card ${CARD16}`);
    expect(result.text).toMatch(/^card FICTA_CARD_[0-9a-f]+$/);
    expect(result.hits).toEqual([expect.objectContaining({ name: "credit-card" })]);
  });

  it("headers follow the same priority", async () => {
    // Headers never reach Presidio, so this uses two in-process detectors in both plugin orders.
    const id: DetectorPlugin = {
      kind: "detector",
      name: "fixture-id",
      detectText: (text): ProtectedValue[] =>
        text.includes(ZA_ID)
          ? [{ name: "za-id-number", value: ZA_ID, source: "fixture", kind: "pii", confidence: "high" }]
          : [],
    };
    for (const plugins of [
      [piiPlugin, id],
      [id, piiPlugin],
    ]) {
      const engine = new ProtectionEngine({
        plugins,
        config: { surrogate: { key: KEY, style: "typed" }, pii: { enabled: true }, ...PRIORITY },
      });
      const header = await engine.redactTextDetailed(`id=${ZA_ID}`, { surface: "header" });
      expect(header.text).toMatch(/^id=FICTA_ID_[0-9a-f]+$/);
      const body = await engine.redactContentDetailed(`id ${ZA_ID}`);
      expect(body.text).toMatch(/^id FICTA_ID_[0-9a-f]+$/);
    }
  });
});

describe("detection.entityPriority config", () => {
  it("normalizes and dedupes category names, keeping their order", () => {
    const config = resolveEngineConfig({
      detection: { entityPriority: ["ZA_ID_NUMBER", " Credit_Card ", "za-id-number"] },
    });
    expect(config.detection.entityPriority).toEqual(["za-id-number", "credit-card"]);
    expect(resolveEngineConfig().detection.entityPriority).toEqual([]);
  });

  it("rejects a malformed category name", () => {
    expect(() => resolveEngineConfig({ detection: { entityPriority: ["credit card"] } })).toThrow(
      InvalidEngineConfigError,
    );
    expect(() => resolveEngineConfig({ detection: { entityPriority: [42 as unknown as string] } })).toThrow(
      /detection\.entityPriority/,
    );
  });
});
