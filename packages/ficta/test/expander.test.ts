import { describe, expect, it } from "vitest";
import { expandEntities, expansionSpans } from "../src/engine/expander.js";
import type { Entity } from "../src/engine/occurrence.js";

describe("expansionSpans", () => {
  it("returns re-anchored UTF-16 ranges for case and single-line whitespace variants", () => {
    const text = "🎉 Viven Bhowani / VIVEN\nBHOWANI / viven\r\n  bhowani";
    const spans = expansionSpans(text, "Viven Bhowani", { caseInsensitive: true, wordBounded: true });

    expect(spans.map((span) => span.surface)).toEqual(["Viven Bhowani", "VIVEN\nBHOWANI", "viven\r\n  bhowani"]);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.surface);
    expect(spans[0]?.start).toBe(text.indexOf("Viven Bhowani"));
  });

  it("does not bridge paragraphs and enforces Unicode-aware token boundaries for short aliases", () => {
    expect(expansionSpans("Viven\n\nBhowani", "Viven Bhowani", { caseInsensitive: true })).toEqual([]);

    const text = "AH signed; ah approved; AHEAD, XAH, AH_ and AHé do not qualify.";
    expect(
      expansionSpans(text, "AH", { caseInsensitive: true, wordBounded: true }).map((span) => span.surface),
    ).toEqual(["AH", "ah"]);
  });

  it("escapes regex punctuation in entity forms", () => {
    const text = "LSD Open (Pty) Ltd and LSD Open Pty Ltd";
    expect(expansionSpans(text, "LSD Open (Pty) Ltd").map((span) => span.surface)).toEqual(["LSD Open (Pty) Ltd"]);
  });
});

describe("expandEntities", () => {
  it("expands canonical and alias forms into leaf-local occurrences with one entity owner", () => {
    const entity = fixtureEntity({
      id: "registry:acme",
      canonical: "Acme Holdings",
      forms: [
        { value: "Acme Holdings", boundary: "token" },
        { value: "AH", boundary: "token" },
        { value: "AH", boundary: "token" },
      ],
      authority: "registry",
    });
    const leaves = ["ACME HOLDINGS retained AH.", "AHEAD is unrelated; Acme Holdings signed."];
    const occurrences = expandEntities(leaves, [entity]);

    expect(
      occurrences.map(({ leaf, surface, origin, entity: owner }) => ({ leaf, surface, origin, id: owner.id })),
    ).toEqual([
      { leaf: 0, surface: "ACME HOLDINGS", origin: "expansion", id: entity.id },
      { leaf: 1, surface: "Acme Holdings", origin: "expansion", id: entity.id },
      { leaf: 0, surface: "AH", origin: "expansion", id: entity.id },
    ]);
    for (const occurrence of occurrences) {
      expect(leaves[occurrence.leaf]?.slice(occurrence.start, occurrence.end)).toBe(occurrence.surface);
    }
  });

  it("keeps digit-bearing registry values out of case expansion", () => {
    const entity = fixtureEntity({ canonical: "Matter NSB-2026", forms: [], authority: "registry" });
    expect(expandEntities(["MATTER NSB-2026", "tagMatter NSB-2026tag"], [entity])).toEqual([
      expect.objectContaining({ leaf: 1, surface: "Matter NSB-2026" }),
    ]);
  });

  it("preserves the detected lowercase-single-word guard but expands multi-token names", () => {
    const will = fixtureEntity({ id: "detected:will", canonical: "Will", forms: [], authority: "detected" });
    const person = fixtureEntity({
      id: "detected:person",
      canonical: "Viven Bhowani",
      forms: [],
      authority: "detected",
    });
    const surfaces = expandEntities(
      ["Will signed; we will proceed; WILL approved; viven bhowani signed."],
      [will, person],
    ).map((occurrence) => occurrence.surface);

    expect(surfaces).toContain("Will");
    expect(surfaces).toContain("WILL");
    expect(surfaces).not.toContain("will");
    expect(surfaces).toContain("viven bhowani");
  });
});

function fixtureEntity(overrides: Partial<Entity>): Entity {
  return {
    id: "fixture",
    canonical: "Fixture Entity",
    forms: [],
    authority: "detected",
    meta: {
      name: "person",
      value: overrides.canonical ?? "Fixture Entity",
      source: "fixture",
      kind: "pii",
      confidence: "high",
    },
    ...overrides,
  };
}
