// Reporting restore (`restoreTextDetailed`): mapped tokens restore exactly as `restoreText` does;
// every other token-shaped string is counted as unknown and, with `unknownToken`, replaced. Unknown
// tokens must never restore to a real value. Tokens are built programmatically so no literal
// surrogate appears in this file.

import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin, ProtectedValue, RegistrySourcePlugin } from "../src/plugins/types.js";
import {
  type ProtectionRecord,
  protectionRecordSurfaces,
  type StructuredRegistrySourceCapabilities,
} from "../src/protection.js";
import { typedSurrogateStrategy } from "../src/surrogate.js";
import { Vault } from "../src/vault.js";

const PREFIX = ["FICTA", ""].join("_");
const SECRET = "corova-control-plane";
const OTHER = "second-registered-value";
const PLACEHOLDER = "[unrestored]";

// Mutations shared with restore-mutation.test.ts.
const upperTail = (s: string): string => s.slice(0, -32) + s.slice(-32).toUpperCase();
const lowerPrefix = (s: string): string => s.replace(PREFIX, PREFIX.toLowerCase());
const dropChar = (s: string): string => s.slice(0, -1);
const spaceMid = (s: string): string => {
  const i = s.length - 16;
  return `${s.slice(0, i)} ${s.slice(i)}`;
};
const flipLastHex = (s: string): string => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");

const MUTATIONS: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ["uppercased hex tail", upperTail],
  ["lowercased prefix", lowerPrefix],
  ["one char dropped", dropChar],
  ["whitespace injected mid-token", spaceMid],
  ["last hex digit changed", flipLastHex],
];

function opaqueVault(): { vault: Vault; token: string; other: string } {
  const vault = new Vault([{ value: SECRET }, { value: OTHER }]);
  return { vault, token: vault.redactText(SECRET).text, other: vault.redactText(OTHER).text };
}

describe("restoreTextDetailed — mapped and unknown tokens", () => {
  it("restores mapped tokens and replaces an unknown one with the placeholder", () => {
    const { vault, token, other } = opaqueVault();
    const unknown = `${PREFIX}${"ab".repeat(16)}`;
    const text = `a ${token} b ${unknown} c ${other} d ${token}`;
    const out = vault.restoreTextDetailed(text, { unknownToken: PLACEHOLDER });
    expect(out).toEqual({
      text: `a ${SECRET} b ${PLACEHOLDER} c ${OTHER} d ${SECRET}`,
      restoredCount: 3,
      unknownCount: 1,
    });
  });

  it("counts unknown typed tokens and leaves the placeholder free of token content", () => {
    const vault = new Vault([{ value: "123-45-6789", name: "us-ssn", kind: "pii" }], typedSurrogateStrategy());
    const token = vault.redactText("123-45-6789").text;
    const unknown = `${PREFIX}PERSON_${"0f".repeat(16)}`;
    const out = vault.restoreTextDetailed(`${token} / ${unknown}`, { unknownToken: PLACEHOLDER });
    expect(out.text).toBe(`123-45-6789 / ${PLACEHOLDER}`);
    expect(out).toMatchObject({ restoredCount: 1, unknownCount: 1 });
  });

  it("treats every token as unknown in an empty vault", () => {
    const vault = new Vault([]);
    const unknown = `${PREFIX}${"cd".repeat(16)}`;
    const out = vault.restoreTextDetailed(`x ${unknown} y`, { unknownToken: PLACEHOLDER });
    expect(out).toEqual({ text: `x ${PLACEHOLDER} y`, restoredCount: 0, unknownCount: 1 });
  });

  for (const [label, mutate] of MUTATIONS) {
    it(`counts a token with ${label} as unknown, replaces it, and never restores it`, () => {
      const { vault, token } = opaqueVault();
      const mutated = mutate(token);
      const out = vault.restoreTextDetailed(`see ${mutated} now`, { unknownToken: PLACEHOLDER });
      expect(out.text).toBe(`see ${PLACEHOLDER} now`);
      expect(out.text).not.toContain(SECRET);
      expect(out).toMatchObject({ restoredCount: 0, unknownCount: 1 });
    });
  }

  it("handles mutated typed tokens the same way", () => {
    const vault = new Vault([{ value: "123-45-6789", name: "us-ssn", kind: "pii" }], typedSurrogateStrategy());
    const token = vault.redactText("123-45-6789").text;
    for (const [, mutate] of MUTATIONS) {
      const out = vault.restoreTextDetailed(`[${mutate(token)}]`, { unknownToken: PLACEHOLDER });
      expect(out.text).toBe(`[${PLACEHOLDER}]`);
      expect(out.unknownCount).toBe(1);
    }
  });

  it("does not touch prose that merely mentions the prefix or a short identifier", () => {
    const { vault } = opaqueVault();
    const text = `set ${PREFIX}SURROGATE_KEY and ${PREFIX}TRACE_AUDIT; ${PREFIX}ADD is not a token`;
    expect(vault.restoreTextDetailed(text, { unknownToken: PLACEHOLDER })).toEqual({
      text,
      restoredCount: 0,
      unknownCount: 0,
    });
  });

  it("restores a mapped token glued to following text exactly as restoreText does", () => {
    const { vault, token } = opaqueVault();
    const text = `${token}0 ${token}s`;
    const out = vault.restoreTextDetailed(text, { unknownToken: PLACEHOLDER });
    expect(out.text).toBe(opaqueVault().vault.restoreText(text));
    expect(out).toMatchObject({ restoredCount: 2, unknownCount: 0 });
  });

  it("does not absorb an unrelated hex word after a complete unknown token", () => {
    const { vault } = opaqueVault();
    const unknown = `${PREFIX}${"ab".repeat(16)}`;
    const out = vault.restoreTextDetailed(`${unknown} deadbeef`, { unknownToken: PLACEHOLDER });
    expect(out.text).toBe(`${PLACEHOLDER} deadbeef`);
  });
});

describe("restoreTextDetailed — default behaviour is unchanged", () => {
  it("returns exactly restoreText's text when no placeholder is set, and still counts", () => {
    const { vault, token } = opaqueVault();
    const reference = opaqueVault().vault;
    const unknown = `${PREFIX}${"ab".repeat(16)}`;
    const text = `${token} ${unknown} ${dropChar(token)} ${upperTail(token)}`;
    const detailed = vault.restoreTextDetailed(text);
    expect(detailed.text).toBe(reference.restoreText(text));
    expect(detailed.text).toBe(`${SECRET} ${unknown} ${dropChar(token)} ${upperTail(token)}`);
    expect(detailed).toMatchObject({ restoredCount: 1, unknownCount: 3 });
  });

  it("feeds the view's residual and restored counters exactly as restoreText does", () => {
    const { vault, token } = opaqueVault();
    const reference = opaqueVault().vault;
    const text = `${token} ${flipLastHex(token)} ${dropChar(token)}`;
    vault.restoreTextDetailed(text, { unknownToken: PLACEHOLDER });
    reference.restoreText(text);
    expect(vault.residualSurrogateCount).toBe(reference.residualSurrogateCount);
    expect(vault.restoredCount).toBe(reference.restoredCount);
  });

  it("leaves restoreText itself untouched: unknown and mutated tokens still pass through", () => {
    const { vault, token } = opaqueVault();
    const text = `${token} ${flipLastHex(token)} ${spaceMid(token)}`;
    expect(vault.restoreText(text)).toBe(`${SECRET} ${flipLastHex(token)} ${spaceMid(token)}`);
  });

  it("honours restore markers like restoreText", () => {
    const { vault, token } = opaqueVault();
    const markers = { start: "\u0002", end: "\u0003" };
    const out = vault.restoreTextDetailed(token, { markers, unknownToken: PLACEHOLDER });
    expect(out.text).toBe(opaqueVault().vault.restoreText(token, { markers }));
  });
});

describe("restoreTextDetailed — placeholder validation", () => {
  for (const bad of ["", `${PREFIX}x`, "pre-ficta_x", `${PREFIX}${"ab".repeat(16)}`]) {
    it(`rejects ${JSON.stringify(bad.slice(0, 8))}… without echoing it`, () => {
      const { vault } = opaqueVault();
      let error: unknown;
      try {
        vault.restoreTextDetailed("text", { unknownToken: bad });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(TypeError);
      if (bad) expect((error as Error).message).not.toContain(bad);
    });
  }
});

// --- engine / keyed scope -------------------------------------------------------------------------

const ORG = "Northstar Biologics (Pty) Ltd";
const ORG_ID = "entity-northstar";
const ORG_RECORD: ProtectionRecord = {
  protectionKind: "entity",
  entityId: ORG_ID,
  entityType: "organization",
  canonical: { formId: `${ORG_ID}:canonical`, value: ORG },
  forms: [{ formId: `${ORG_ID}:form:0`, value: "Northstar", kind: "short_name", boundary: "token" }],
  provenance: "registry",
  meta: { name: "organization", value: ORG, source: "fixture", kind: "pii", confidence: "exact" },
};

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

function valueDetector(category: string, value: string): DetectorPlugin {
  return {
    kind: "detector",
    name: `fixture-${category}`,
    bodyDetectionView: "content",
    detectText: (text) =>
      text.includes(value)
        ? [{ name: category, value, source: "fixture", kind: "pii", confidence: "high" } satisfies ProtectedValue]
        : [],
  };
}

describe("restoreTextDetailed — engine and scopes", () => {
  it("replaces an entity-family wildcard reference and keeps the mapped entity token", async () => {
    const engine = new ProtectionEngine({ allowEphemeralKey: true, plugins: [structuredRegistry([ORG_RECORD])] });
    const scope = engine.beginRequest("org:thread-wildcard");
    const { text } = await scope.redactContentDetailed(`${ORG} signed.`);
    const token = text.match(/FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}/u)?.[0];
    expect(token).toBeDefined();
    const wildcard = `${token?.split("_").slice(0, 3).join("_")}_*`;
    const out = scope.restoreTextDetailed(`${token} and every ${wildcard} form`, { unknownToken: PLACEHOLDER });
    expect(out.text).toBe(`${ORG} and every ${PLACEHOLDER} form`);
    expect(out).toMatchObject({ restoredCount: 1, unknownCount: 1 });
  });

  it("never counts or replaces destroy markers", async () => {
    const card = "4111 1111 1111 1111";
    const email = "pat.example@example.com";
    const engine = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [valueDetector("credit-card", card), valueDetector("email", email)],
      config: { dispositions: { destroy: { categories: ["credit-card"] } } },
    });
    const scope = engine.beginRequest();
    const { text } = await scope.redactContentDetailed(`card ${card} mail ${email}`);
    expect(text).toContain("[REDACTED_");
    const out = scope.restoreTextDetailed(text, { unknownToken: PLACEHOLDER });
    expect(out.text).toMatch(/^card \[REDACTED_[A-Z0-9_]+\] mail pat\.example@example\.com$/u);
    expect(out).toMatchObject({ restoredCount: 1, unknownCount: 0 });
  });

  it("is available on the engine's default scope", async () => {
    const engine = new ProtectionEngine({ allowEphemeralKey: true, values: [{ name: "token", value: SECRET }] });
    const { text } = await engine.redactContentDetailed(`use ${SECRET}`);
    const out = engine.restoreTextDetailed(`${text} ${dropChar(text.slice(4))}`, { unknownToken: PLACEHOLDER });
    expect(out.text).toBe(`use ${SECRET} ${PLACEHOLDER}`);
    expect(out).toMatchObject({ restoredCount: 1, unknownCount: 1 });
  });
});
