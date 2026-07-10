import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { normalizeMarkdownForDetection } from "../src/engine/plugins/pii/markdown.js";
import type { DetectorPlugin, ProtectedValue } from "../src/plugins/index.js";

const FIXTURE_ROOT = new URL("./fixtures/entity-redaction/", import.meta.url);

afterEach(() => {
  delete process.env.FICTA_BODY_REDACTION_LEGACY;
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

  it("protects markitdown party shapes while pinning the one Phase 4 internal-markdown survivor", async () => {
    const hoa = fixture("markitdown-hoa.md");
    const detected = ["Viven Bhowani", "Elton Lau", "LSD LIMITED SEYCHELLES"];
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
    expect(redacted.body).toContain("LSD **Open** FZCO");
  });
});

describe("legacy/new body-path differential", () => {
  it("records the intentional authority/provenance difference while preserving restoration", async () => {
    const registry = protectedValue("PROJECT", "Project Copper Kite", "env-file", "secret", "exact");
    const surface = "Project:** Project Copper Kite";
    const body = JSON.stringify({ content: surface });
    const run = async (legacy: boolean) => {
      if (legacy) process.env.FICTA_BODY_REDACTION_LEGACY = "1";
      else delete process.env.FICTA_BODY_REDACTION_LEGACY;
      const engine = new ProtectionEngine({ plugins: [fixtureDetector([surface])], values: [registry] });
      const result = await engine.redactBodyDetailed(body, { traceValues: true });
      return {
        result,
        restored: engine.restoreText(result.body),
        survivor: result.body.includes("Project Copper Kite"),
        attribution: result.hits.map((hit) => `${hit.source}:${hit.name}`),
        provenance: result.traceValues?.map((value) => value.provenance),
      };
    };

    const legacy = await run(true);
    const occurrence = await run(false);
    expect(legacy.restored).toBe(occurrence.restored);
    expect(occurrence.restored).toContain(surface);
    expect(legacy.survivor).toBe(false);
    expect(occurrence.survivor).toBe(false);
    expect(legacy.attribution).toContain("fixture-detector:organization");
    expect(occurrence.attribution).toContain("env-file:PROJECT");
    expect(occurrence.provenance).toContain("permanent");
  });

  it("runs both golden fixtures and a seeded overlap corpus through old and new paths", async () => {
    const legal = fixture("legal-memo.md");
    const hoa = fixture("markitdown-hoa.md");
    const cases: DifferentialCase[] = [
      {
        name: "legal-golden",
        body: JSON.stringify({ content: legal }),
        values: registryFixture("legal-registry.env"),
        plugin: fixtureDetector(["Project:** Project Copper Kite", "Proxima Medical\nSupplies CC"]),
        expectedSurfaces: ["Project Copper Kite", "Amelia Naidoo", "Jordan Price"],
      },
      {
        name: "markitdown-golden",
        body: JSON.stringify({ content: hoa }),
        values: [
          protectedValue("JURISDICTION", "Mauritius", "golden-registry", "secret", "exact"),
          protectedValue("JURISDICTION", "UAE", "golden-registry", "secret", "exact"),
        ],
        plugin: normalizedFixtureDetector(["Viven Bhowani", "Elton Lau", "LSD LIMITED SEYCHELLES"]),
        expectedSurfaces: ["VIVEN BHOWANI", "ELTON LAU", "LSD LIMITED SEYCHELLES", "MAURITIUS", "UAE"],
      },
    ];
    const random = mulberry32(0x44494646);
    for (let i = 0; i < 12; i++) {
      const inner = `Registered Secret ${Math.floor(random() * 1_000_000)}`;
      const outer = `Prefix${i}: ${inner} :Suffix${i}`;
      cases.push({
        name: `seed-${i}`,
        body: JSON.stringify({ content: outer }),
        values: [protectedValue("SEEDED", inner, "seed-registry", "secret", "exact")],
        plugin: fixtureDetector([outer]),
        expectedSurfaces: [inner],
      });
    }

    const records = [];
    for (const item of cases) {
      const legacy = await differentialSnapshot(item, true);
      const occurrence = await differentialSnapshot(item, false);
      records.push({
        name: item.name,
        legacySurvivors: legacy.survivors,
        occurrenceSurvivors: occurrence.survivors,
        legacyAttribution: legacy.attribution,
        occurrenceAttribution: occurrence.attribution,
        legacyProvenance: legacy.provenance,
        occurrenceProvenance: occurrence.provenance,
        restorationChanged: legacy.restored !== occurrence.restored,
      });
      expect(occurrence.survivors, item.name).toEqual([]);
      expect(occurrence.leaks, item.name).toBe(0);
    }
    expect(records.map((record) => record.name)).toEqual(cases.map((item) => item.name));
    expect(records.find((record) => record.name === "legal-golden")?.occurrenceAttribution).toContain(
      "golden-registry:CONFIDENTIAL_PROJECT_NAME",
    );
  });
});

interface DifferentialCase {
  name: string;
  body: string;
  values: ProtectedValue[];
  plugin: DetectorPlugin;
  expectedSurfaces: string[];
}

async function differentialSnapshot(item: DifferentialCase, legacy: boolean) {
  if (legacy) process.env.FICTA_BODY_REDACTION_LEGACY = "1";
  else delete process.env.FICTA_BODY_REDACTION_LEGACY;
  const engine = new ProtectionEngine({ plugins: [item.plugin], values: item.values });
  const result = await engine.redactBodyDetailed(item.body, { traceValues: true });
  return {
    survivors: item.expectedSurfaces.filter((value) => result.body.includes(value)),
    leaks: result.leaks,
    attribution: result.hits.map((hit) => `${hit.source}:${hit.name}`),
    provenance: result.traceValues?.map((value) => value.provenance) ?? [],
    restored: engine.restoreJson(result.body),
  };
}

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
      return values.flatMap((value) => detectedSpan(normalized, value));
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

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
