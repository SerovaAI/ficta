import { describe, expect, it } from "vitest";
import {
  type Entity,
  mapJoinedOffsets,
  type Occurrence,
  resolveOccurrences,
  spliceResolvedOccurrences,
} from "../src/engine/occurrence.js";
import { RedactionInvariantError } from "../src/engine/redaction-engine.js";

describe("occurrence resolver", () => {
  it("lets a registry entity own its exact span and clips a noisy detected superset", () => {
    const text = "Project:** Project Copper Kite";
    const detected = occurrence(text, 0, text.length, entity("detected-org", "detected", text));
    const registryStart = text.indexOf("Project Copper Kite");
    const registry = occurrence(
      text,
      registryStart,
      text.length,
      entity("registry-project", "registry", "Project Copper Kite"),
      "expansion",
    );

    expect(resolveOccurrences([detected, registry])).toEqual([
      {
        ...occurrence(text, 0, "Project:**".length, detected.entity, "clipped"),
        clipped: true,
        clippedBy: "registry",
      },
      { ...registry, clipped: false },
    ]);
  });

  it("lets registry authority win an exact-range tie", () => {
    const text = "Proxima Medical\nSupplies CC";
    const detected = occurrence(text, 0, text.length, entity("detected-org", "detected", text, "exact"));
    const registry = occurrence(
      text,
      0,
      text.length,
      entity("registry-org", "registry", text, "probabilistic"),
      "expansion",
    );

    expect(resolveOccurrences([detected, registry])).toEqual([{ ...registry, clipped: false }]);
  });

  it("clips both sides of a losing span and trims only residual whitespace", () => {
    const text = "abc  SECRET  xyz";
    const detected = occurrence(text, 0, text.length, entity("detected", "detected", text));
    const start = text.indexOf("SECRET");
    const registry = occurrence(text, start, start + "SECRET".length, entity("registry", "registry", "SECRET"));

    expect(resolveOccurrences([registry, detected])).toEqual([
      {
        ...occurrence(text, 0, 3, detected.entity, "clipped"),
        clipped: true,
        clippedBy: "registry",
      },
      { ...registry, clipped: false },
      {
        ...occurrence(text, text.indexOf("xyz"), text.length, detected.entity, "clipped"),
        clipped: true,
        clippedBy: "registry",
      },
    ]);
  });

  it("uses confidence then stable entity id after authority and span ties", () => {
    const text = "Northstar";
    const probabilistic = occurrence(
      text,
      0,
      text.length,
      entity("a-probabilistic", "detected", text, "probabilistic"),
    );
    const highB = occurrence(text, 0, text.length, entity("b-high", "detected", text, "high"));
    const exactB = occurrence(text, 0, text.length, entity("b-exact", "detected", text, "exact"));
    const exactA = occurrence(text, 0, text.length, entity("a-exact", "detected", text, "exact"));

    expect(resolveOccurrences([probabilistic, exactB, highB, exactA])).toEqual([{ ...exactA, clipped: false }]);
  });

  it("resolves nested and chained overlaps without overlap or partial non-whitespace coverage", () => {
    const text = "abcdefghijklmnop";
    const claims = [
      occurrence(text, 0, 10, entity("wide", "detected", text.slice(0, 10), "probabilistic")),
      occurrence(text, 3, 7, entity("registry", "registry", text.slice(3, 7), "exact"), "expansion"),
      occurrence(text, 6, 14, entity("high", "detected", text.slice(6, 14), "high")),
      occurrence(text, 12, 16, entity("tail", "detected", text.slice(12, 16), "exact")),
    ];
    const resolved = resolveOccurrences(claims);

    assertOrderedAndNonOverlapping(resolved);
    assertCoverage(text, claims, resolved);
    expect(resolveOccurrences(resolved)).toEqual(resolved);
  });

  it("is deterministic, permutation-invariant, idempotent, and coverage-preserving over seeded claims", () => {
    const random = mulberry32(0x5eedc0de);
    const alphabet = "abc def ghi jkl mno pqr stu vwx yz";
    for (let run = 0; run < 150; run++) {
      const length = 8 + Math.floor(random() * 48);
      let text = "";
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)] ?? "x";
      const claims: Occurrence[] = [];
      const count = 1 + Math.floor(random() * 18);
      for (let i = 0; i < count; i++) {
        const start = Math.floor(random() * text.length);
        const end = start + 1 + Math.floor(random() * (text.length - start));
        const authority = random() < 0.25 ? "registry" : "detected";
        const confidence = (["exact", "high", "probabilistic"] as const)[Math.floor(random() * 3)];
        claims.push(occurrence(text, start, end, entity(`${run}:${i}`, authority, text.slice(start, end), confidence)));
      }

      const expected = resolveOccurrences(claims);
      const shuffled = shuffle([...claims], random);
      expect(resolveOccurrences(shuffled)).toEqual(expected);
      expect(resolveOccurrences(expected)).toEqual(expected);
      assertOrderedAndNonOverlapping(expected);
      assertCoverage(text, claims, expected);
      for (const resolved of expected) {
        expect(resolved.surface).toBe(text.slice(resolved.start, resolved.end));
        expect(resolved.entity.id).toBeTruthy();
      }
    }
  });

  it("rejects invalid ranges, stale surfaces, and conflicting entity ids", () => {
    const text = "Northstar";
    const valid = occurrence(text, 0, text.length, entity("same", "registry", text));
    expect(() => resolveOccurrences([{ ...valid, end: text.length + 1 }])).toThrow(/re-anchor/);
    expect(() =>
      resolveOccurrences([valid, occurrence(text, 0, text.length, entity("same", "detected", text))]),
    ).toThrow(/conflicting identity/);
  });
});

describe("mapJoinedOffsets", () => {
  it("maps joined offsets into the corresponding full leaf", () => {
    const leaves = ["ignored", "Proxima Medical Supplies CC", "tail"];
    const joined = leaves.join("\n");
    const start = joined.indexOf("Proxima");
    const item = entity("proxima", "detected", "Proxima Medical Supplies CC");

    expect(
      mapJoinedOffsets(leaves, [2, 5, 9], {
        start,
        end: start + item.canonical.length,
        entity: item,
        origin: "detector",
      }),
    ).toEqual([
      {
        leaf: 5,
        start: 0,
        end: item.canonical.length,
        surface: item.canonical,
        origin: "detector",
        entity: item,
      },
    ]);
  });

  it("clips a detector span across adjacent content leaves and drops the synthetic newline", () => {
    const leaves = ["Alpha North", "Star Omega"];
    const joined = leaves.join("\n");
    const start = joined.indexOf("North");
    const end = joined.indexOf(" Omega");
    const item = entity("north-star", "detected", "North\nStar");

    expect(mapJoinedOffsets(leaves, [3, 8], { start, end, entity: item, origin: "detector" })).toEqual([
      { leaf: 3, start: 6, end: 11, surface: "North", origin: "clipped", entity: item },
      { leaf: 8, start: 0, end: 4, surface: "Star", origin: "clipped", entity: item },
    ]);
  });

  it("uses UTF-16 offsets and validates the fresh-to-full leaf mapping", () => {
    const leaves = ["😀 Acme", "尾部"];
    const item = entity("unicode", "detected", "Acme");
    expect(mapJoinedOffsets(leaves, [4, 7], { start: 3, end: 7, entity: item, origin: "detector" })[0]).toMatchObject({
      leaf: 4,
      start: 3,
      end: 7,
      surface: "Acme",
    });
    expect(() => mapJoinedOffsets(leaves, [4], { start: 0, end: 1, entity: item, origin: "detector" })).toThrow(
      /align/,
    );
    expect(() => mapJoinedOffsets(leaves, [4, 4], { start: 0, end: 1, entity: item, origin: "detector" })).toThrow(
      /unique/,
    );
  });
});

describe("spliceResolvedOccurrences", () => {
  it("splices non-overlapping claims from right to left", () => {
    const text = "Alpha and Beta";
    const claims = resolveOccurrences([
      occurrence(text, 0, 5, entity("alpha", "registry", "Alpha"), "expansion"),
      occurrence(text, 10, 14, entity("beta", "detected", "Beta"), "detector"),
    ]);
    expect(spliceResolvedOccurrences(text, claims, (claim) => `<${claim.entity.id}>`)).toBe("<alpha> and <beta>");
  });

  it("throws the always-blocking invariant error before minting on a re-anchor mismatch", () => {
    const saved = process.env.FICTA_FAIL_CLOSED;
    process.env.FICTA_FAIL_CLOSED = "0";
    const claim = {
      ...occurrence("Alpha", 0, 5, entity("alpha", "registry", "Alpha"), "expansion"),
      surface: "Wrong",
      clipped: false,
    };
    let minted = false;
    try {
      expect(() =>
        spliceResolvedOccurrences("Alpha", [claim], () => {
          minted = true;
          return "token";
        }),
      ).toThrow(RedactionInvariantError);
      expect(minted).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.FICTA_FAIL_CLOSED;
      else process.env.FICTA_FAIL_CLOSED = saved;
    }
  });
});

function entity(
  id: string,
  authority: Entity["authority"],
  canonical: string,
  confidence: Entity["meta"]["confidence"] = authority === "registry" ? "exact" : "probabilistic",
): Entity {
  return {
    id,
    canonical,
    forms: [],
    authority,
    meta: { name: id, value: canonical, source: "test", kind: authority === "registry" ? "secret" : "pii", confidence },
  };
}

function occurrence(
  text: string,
  start: number,
  end: number,
  item: Entity,
  origin: Occurrence["origin"] = "detector",
): Occurrence {
  return { leaf: 0, start, end, surface: text.slice(start, end), origin, entity: item };
}

function assertOrderedAndNonOverlapping(resolved: readonly Occurrence[]): void {
  for (let i = 0; i < resolved.length; i++) {
    const current = resolved[i];
    if (!current) continue;
    expect(current.end).toBeGreaterThan(current.start);
    const previous = resolved[i - 1];
    if (previous) {
      expect(current.leaf > previous.leaf || current.start >= previous.end).toBe(true);
    }
  }
}

function assertCoverage(text: string, claims: readonly Occurrence[], resolved: readonly Occurrence[]): void {
  for (let index = 0; index < text.length; index++) {
    if (/\s/u.test(text[index] ?? "")) continue;
    const claimed = claims.some((claim) => claim.start <= index && claim.end > index);
    const covered = resolved.some((item) => item.start <= index && item.end > index);
    if (claimed) expect(covered, `expected code unit ${index} to remain covered`).toBe(true);
  }
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

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = values[i];
    const b = values[j];
    if (a !== undefined && b !== undefined) {
      values[i] = b;
      values[j] = a;
    }
  }
  return values;
}
