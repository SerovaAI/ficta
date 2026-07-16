import { SUPPORTED_DETECTION_JURISDICTIONS } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASELINE_ENTITIES,
  detectionProfileFromCodes,
  effectivePresidioEntities,
  JURISDICTION_ENTITY_BUNDLES,
} from "../src/engine/plugins/pii/jurisdictions.js";
import { categoryOf } from "../src/engine/plugins/pii/presidio-recognizer.js";
import { typedSurrogateStrategy } from "../src/engine/surrogate.js";

/**
 * Sync gates for the jurisdiction seam: the bundle map, the protocol vocabulary, the default
 * baseline, and the surrogate type table must agree, or a profile toggle silently does nothing (or
 * quietly widens default-traffic detection). The live-sidecar half of this contract (baseline
 * matches /supportedentities) is enforced by scripts/verify-presidio-sidecar.mts.
 */
describe("jurisdiction bundles", () => {
  it("covers exactly the protocol's supported jurisdictions", () => {
    expect(Object.keys(JURISDICTION_ENTITY_BUNDLES).sort()).toEqual([...SUPPORTED_DETECTION_JURISDICTIONS].sort());
  });

  it("keeps every UK entity out of the default baseline (profile isolation)", () => {
    for (const entity of JURISDICTION_ENTITY_BUNDLES.uk ?? []) {
      expect(DEFAULT_BASELINE_ENTITIES).not.toContain(entity);
    }
  });

  it("maps every bundled entity to a specific surrogate type (no generic PII fallback)", () => {
    const strategy = typedSurrogateStrategy("test-key");
    for (const bundle of Object.values(JURISDICTION_ENTITY_BUNDLES)) {
      for (const entity of bundle) {
        const token = strategy.mint("value", { name: categoryOf(entity), kind: "pii" });
        expect(token, `${entity} (${categoryOf(entity)}) fell back to a generic type`).not.toMatch(
          /^FICTA_(?:PII|REDACTED)_/,
        );
      }
    }
  });
});

describe("effectivePresidioEntities", () => {
  it("is never empty and defaults to the baseline", () => {
    expect(effectivePresidioEntities([], undefined)).toEqual(DEFAULT_BASELINE_ENTITIES);
  });

  it("unions bundles without duplicating overlapping baseline entities", () => {
    const effective = effectivePresidioEntities([], { jurisdictions: ["za", "uk"] });
    expect(new Set(effective).size).toBe(effective.length);
    expect(effective).toContain("UK_NHS");
    expect(effective).toContain("ZA_ID_NUMBER");
  });

  it("ignores unknown jurisdiction codes", () => {
    expect(effectivePresidioEntities([], { jurisdictions: ["atlantis"] })).toEqual(DEFAULT_BASELINE_ENTITIES);
  });

  it("ignores inherited object keys without widening or crashing", () => {
    expect(effectivePresidioEntities([], { jurisdictions: ["constructor", "__proto__", "toString"] })).toEqual(
      DEFAULT_BASELINE_ENTITIES,
    );
  });
});

describe("detectionProfileFromCodes", () => {
  it("normalizes, dedupes, and drops unsupported codes", () => {
    expect(detectionProfileFromCodes([" UK ", "uk", "za", "xx"])).toEqual({ jurisdictions: ["uk", "za"] });
    expect(detectionProfileFromCodes(["xx", ""])).toBeUndefined();
    expect(detectionProfileFromCodes([])).toBeUndefined();
  });

  it("rejects inherited object keys (prototype members are not jurisdictions)", () => {
    expect(detectionProfileFromCodes(["constructor", "__proto__", "toString", "hasOwnProperty"])).toBeUndefined();
  });
});
