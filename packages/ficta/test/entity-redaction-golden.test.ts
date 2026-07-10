import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { normalizeMarkdownForDetection } from "../src/engine/plugins/pii/markdown.js";
import type { DetectorPlugin, ProtectedValue } from "../src/plugins/index.js";

const FIXTURE_ROOT = new URL("./fixtures/entity-redaction/", import.meta.url);

afterEach(() => {
  delete process.env.FICTA_SURROGATE_STYLE;
});

describe("entity redaction golden fixtures", () => {
  it("protects the legal memo with registry authority across noisy and reflowed detector spans", async () => {
    const memo = fixture("legal-memo.md");
    const values = registryFixture("legal-registry.env");
    const detector = fixtureDetector(["Project:** Project Copper Kite", "Proxima Medical\nSupplies CC"]);
    const engine = new ProtectionEngine({ plugins: [detector], values });
    const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: memo }), { traceValues: true });

    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain("Project Copper Kite");
    expect(redacted.body).not.toContain("Proxima Medical");
    expect(redacted.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "CONFIDENTIAL_PROJECT_NAME", source: "golden-registry" }),
        expect.objectContaining({ name: "OPPOSING_PARTY", source: "golden-registry" }),
      ]),
    );
    expect(redacted.traceValues?.find((value) => value.name === "OPPOSING_PARTY")?.provenance).toBe("permanent");
    const restored = engine.restoreText(redacted.body);
    expect(restored).toContain("Project:** Project Copper Kite");
    expect(restored).toContain("Proxima Medical\nSupplies CC");
  });

  it("protects every markitdown party shape, including internal Markdown", async () => {
    const hoa = fixture("markitdown-hoa.md");
    const detected = ["Viven Bhowani", "Elton Lau", "LSD LIMITED SEYCHELLES", "LSD Open FZCO"];
    const engine = new ProtectionEngine({
      plugins: [normalizedFixtureDetector(detected)],
      values: [
        protectedValue("JURISDICTION", "Mauritius", "golden-registry", "secret", "exact"),
        protectedValue("JURISDICTION", "UAE", "golden-registry", "secret", "exact"),
      ],
    });
    const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: hoa }));

    expect(redacted.leaks).toBe(0);
    for (const value of [...detected, "VIVEN BHOWANI", "ELTON LAU", "MAURITIUS", "UAE"]) {
      expect(redacted.body).not.toContain(value);
    }
    expect(redacted.body).not.toContain("LSD **Open** FZCO");
  });
});

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), "utf8");
}

function registryFixture(name: string): ProtectedValue[] {
  return fixture(name)
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const split = line.indexOf("=");
      return protectedValue(line.slice(0, split), line.slice(split + 1), "golden-registry", "secret", "exact");
    });
}

function fixtureDetector(values: readonly string[]): DetectorPlugin {
  return {
    kind: "detector",
    name: "pii",
    bodyDetectionView: "content",
    detectText: (text) => values.flatMap((value) => detectedSpan(text, value)),
  };
}

function normalizedFixtureDetector(values: readonly string[]): DetectorPlugin {
  return {
    kind: "detector",
    name: "pii",
    bodyDetectionView: "content",
    detectText: (text) => {
      const normalized = normalizeMarkdownForDetection(text);
      return values.flatMap((value) => {
        const start = normalized.text.indexOf(value);
        const rawStart = normalized.toRaw(start, "start");
        const rawEnd = normalized.toRaw(start + value.length, "end");
        return start === -1 || rawStart === undefined || rawEnd === undefined
          ? []
          : [
              {
                ...protectedValue("organization", value, "fixture-detector", "pii", "high"),
                spans: [{ start: rawStart, end: rawEnd }],
              },
            ];
      });
    },
  };
}

function detectedSpan(text: string, value: string): ProtectedValue[] {
  const start = text.indexOf(value);
  return start === -1
    ? []
    : [
        {
          ...protectedValue("organization", value, "fixture-detector", "pii", "high"),
          spans: [{ start, end: start + value.length }],
        },
      ];
}

function protectedValue(
  name: string,
  value: string,
  source: string,
  kind: ProtectedValue["kind"],
  confidence: ProtectedValue["confidence"],
): ProtectedValue {
  return { name, value, source, kind, confidence };
}
