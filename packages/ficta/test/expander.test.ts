import { describe, expect, it } from "vitest";
import { expandEntities, expansionSpans } from "../src/engine/expander.js";
import type { Entity, EntityClaim } from "../src/engine/occurrence.js";

describe("expansionSpans", () => {
  it("returns re-anchored UTF-16 ranges for case and single-line whitespace variants", () => {
    const text = "🎉 Avery Example / AVERY\nEXAMPLE / avery\r\n  example";
    const spans = expansionSpans(text, "Avery Example", { caseInsensitive: true, wordBounded: true });

    expect(spans.map((span) => span.surface)).toEqual(["Avery Example", "AVERY\nEXAMPLE", "avery\r\n  example"]);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.surface);
    expect(spans[0]?.start).toBe(text.indexOf("Avery Example"));
  });

  it("does not bridge paragraphs and enforces Unicode-aware token boundaries for short aliases", () => {
    expect(expansionSpans("Avery\n\nExample", "Avery Example", { caseInsensitive: true })).toEqual([]);

    const text = "AH signed; ah approved; AHEAD, XAH, AH_ and AHé do not qualify.";
    expect(
      expansionSpans(text, "AH", { caseInsensitive: true, wordBounded: true }).map((span) => span.surface),
    ).toEqual(["AH", "ah"]);
  });

  it("escapes regex punctuation in entity forms", () => {
    const text = "Blue Lantern (Pty) Ltd and Blue Lantern Pty Ltd";
    expect(expansionSpans(text, "Blue Lantern (Pty) Ltd").map((span) => span.surface)).toEqual([
      "Blue Lantern (Pty) Ltd",
    ]);
  });
});

describe("expandEntities", () => {
  it("expands canonical and alias forms into leaf-local occurrences with one entity owner", () => {
    const claim = fixtureEntity(
      {
        id: "registry:acme",
        canonical: "Acme Holdings",
        forms: [
          { value: "Acme Holdings", boundary: "token" },
          { value: "AH", boundary: "token" },
          { value: "AH", boundary: "token" },
        ],
      },
      "registry",
    );
    const leaves = ["ACME HOLDINGS retained AH.", "AHEAD is unrelated; Acme Holdings signed."];
    const occurrences = expandEntities(leaves, [claim]);

    expect(
      occurrences.map(({ leaf, surface, origin, entity: owner }) => ({ leaf, surface, origin, id: owner.id })),
    ).toEqual([
      { leaf: 0, surface: "ACME HOLDINGS", origin: "expansion", id: claim.entity.id },
      { leaf: 1, surface: "Acme Holdings", origin: "expansion", id: claim.entity.id },
      { leaf: 0, surface: "AH", origin: "expansion", id: claim.entity.id },
    ]);
    for (const occurrence of occurrences) {
      expect(leaves[occurrence.leaf]?.slice(occurrence.start, occurrence.end)).toBe(occurrence.surface);
    }
  });

  it("keeps digit-bearing registry values out of case expansion", () => {
    const claim = fixtureEntity({ canonical: "Matter NSB-2026", forms: [] }, "registry");
    expect(expandEntities(["MATTER NSB-2026", "tagMatter NSB-2026tag"], [claim])).toEqual([
      expect.objectContaining({ leaf: 1, surface: "Matter NSB-2026" }),
    ]);
  });

  it("preserves the detected lowercase-single-word guard but expands multi-token names", () => {
    const will = fixtureEntity({ id: "detected:will", canonical: "Will", forms: [] }, "detected");
    const person = fixtureEntity(
      {
        id: "detected:person",
        canonical: "Avery Example",
        forms: [],
      },
      "detected",
    );
    const surfaces = expandEntities(
      ["Will signed; we will proceed; WILL approved; avery example signed."],
      [will, person],
    ).map((occurrence) => occurrence.surface);

    expect(surfaces).toContain("Will");
    expect(surfaces).toContain("WILL");
    expect(surfaces).not.toContain("will");
    expect(surfaces).toContain("avery example");
  });
});

function fixtureEntity(
  overrides: Partial<Entity>,
  authority: EntityClaim["mention"]["resolverAuthority"] = "detected",
): EntityClaim {
  const canonical = overrides.canonical ?? "Fixture Entity";
  return {
    entity: {
      id: "fixture",
      protectionKind: "literal",
      provenance: authority === "registry" ? "registry" : "detector",
      canonical,
      forms: [],
      ...overrides,
    },
    meta: {
      name: "person",
      value: canonical,
      source: "fixture",
      kind: "pii",
      confidence: "high",
    },
    mention: {
      detectionSource: authority === "registry" ? "registry" : "detector",
      detectionConfidence: "high",
      linkSource: "none",
      resolverAuthority: authority,
      protectionEligible: true,
    },
  };
}
