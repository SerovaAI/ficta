import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { entityLinkAnchorIndex, linkDetectedEntityClaims } from "../src/engine/entity-linker.js";
import type { EntityClaim } from "../src/engine/occurrence.js";
import {
  entityClaimsFromProtectionRecords,
  literalProtectionRecords,
  type ProtectionRecord,
  protectionRecordSurfaces,
  type RegisteredEntityProtection,
  type StructuredRegistrySourceCapabilities,
} from "../src/engine/protection.js";
import type { DetectorPlugin, ProtectedValue, RegistrySourcePlugin } from "../src/plugins/index.js";

afterEach(() => {
  delete process.env.FICTA_SURROGATE_KEY;
});

describe("registered-anchor entity linking", () => {
  it("links a unique high-confidence organization short name without upgrading mention trust", () => {
    const anchor = entityClaim(entityRecord("northstar", "The Northstar Biologics (Pty) Ltd"));
    const detected = detectedClaim("Northstar", "high");

    const [linked] = linkDetectedEntityClaims(entityLinkAnchorIndex([anchor]), [detected]);

    expect(linked?.entity.id).toBe("northstar");
    expect(linked?.meta).toBe(detected.meta);
    expect(linked?.mention).toEqual({
      detectionSource: "detector",
      detectionConfidence: "high",
      linkSource: "deterministic_alias",
      linkConfidence: "high",
      resolverAuthority: "detected",
      protectionEligible: true,
    });
    expect(linked?.ambiguousEntityLink).toBeUndefined();
  });

  it("indexes canonical and declared organization forms under distinct short keys", () => {
    const anchor = entityClaim(
      entityRecord("lantern", "Global Holdings Limited", [
        { formId: "lantern:blue", value: "Blue Lantern FZCO", kind: "short_name", boundary: "substring" },
      ]),
    );

    const anchors = entityLinkAnchorIndex([anchor]);
    expect(linkDetectedEntityClaims(anchors, [detectedClaim("Global", "exact")])[0]?.entity.id).toBe("lantern");
    expect(linkDetectedEntityClaims(anchors, [detectedClaim("Blue", "high")])[0]?.entity.id).toBe("lantern");
  });

  it("keeps ambiguous aliases literal and records every candidate without an arbitrary tie-break", () => {
    const anchors = [
      entityClaim(entityRecord("northstar-biologics", "Northstar Biologics Ltd")),
      entityClaim(entityRecord("northstar-finance", "Northstar Finance LLC")),
    ];
    const detected = detectedClaim("Northstar", "high");

    const [ambiguous] = linkDetectedEntityClaims(entityLinkAnchorIndex(anchors), [detected]);

    expect(ambiguous?.entity.id).toBe(detected.entity.id);
    expect(ambiguous?.mention.linkSource).toBe("none");
    expect(ambiguous?.ambiguousEntityLink).toEqual({
      code: "AMBIGUOUS_ENTITY_LINK",
      linkingRule: "organization_short_name",
      candidateEntityIds: ["northstar-biologics", "northstar-finance"],
    });
  });

  it("does not infer multi-word, probabilistic, person, or detector-only mentions", () => {
    const organization = entityClaim(entityRecord("northstar", "Northstar Biologics Ltd"));
    const person = entityClaim(entityRecord("avery", "Avery Example", [], "person"));
    const claims = [
      detectedClaim("Northstar Biologics", "high"),
      detectedClaim("Northstar", "probabilistic"),
      detectedClaim("Avery", "high", "person"),
      detectedClaim("Unregistered", "high"),
    ];

    const linked = linkDetectedEntityClaims(entityLinkAnchorIndex([organization, person]), claims);

    expect(linked.map((claim) => claim.entity.id)).toEqual(claims.map((claim) => claim.entity.id));
    expect(linked.every((claim) => claim.mention.linkSource === "none")).toBe(true);
    expect(linked.every((claim) => claim.ambiguousEntityLink === undefined)).toBe(true);
  });

  it("keeps current literal rendering while reporting only values-free ambiguity details", async () => {
    process.env.FICTA_SURROGATE_KEY = "phase-3-anchored-linking-test-key";
    const records = [
      entityRecord("northstar-biologics", "Northstar Biologics Ltd"),
      entityRecord("northstar-finance", "Northstar Finance LLC"),
    ];
    const detector = organizationDetector("Northstar");
    const engine = new ProtectionEngine({ plugins: [structuredRegistry(records), detector] });
    const body = JSON.stringify({ content: "Northstar retained counsel. Northstar approved the filing." });

    const result = await engine.beginRequest("org:thread-phase-3").redactBodyDetailed(body, { traceValues: true });

    expect(result.leaks).toBe(0);
    expect(result.ambiguousEntityLinks).toBe(2);
    expect(result.body).not.toContain("Northstar");
    expect(engine.beginRequest("org:thread-phase-3").restoreJson(result.body)).toBe(body);
    expect(result.traceAmbiguousEntityLinks).toHaveLength(2);
    expect(result.traceAmbiguousEntityLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AMBIGUOUS_ENTITY_LINK",
          linkingRule: "organization_short_name",
          candidateCount: 2,
          candidateEntityIds: [expect.stringMatching(/^[0-9a-f]{16}$/), expect.stringMatching(/^[0-9a-f]{16}$/)],
          contextHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        }),
      ]),
    );
    const diagnostics = JSON.stringify(result.traceAmbiguousEntityLinks);
    expect(diagnostics).not.toContain("Northstar");
    expect(diagnostics).not.toContain("northstar-biologics");
    expect(diagnostics).not.toContain("northstar-finance");
    expect(diagnostics).not.toContain("org:thread-phase-3");
  });

  it("keeps a uniquely linked alias byte-identical to the existing detector-only renderer", async () => {
    process.env.FICTA_SURROGATE_KEY = "phase-3-rendering-equivalence-key";
    const detector = organizationDetector("Northstar");
    const linked = new ProtectionEngine({
      plugins: [structuredRegistry([entityRecord("northstar", "Northstar Biologics Ltd")]), detector],
    });
    const literal = new ProtectionEngine({ plugins: [detector] });
    const body = JSON.stringify({ content: "Northstar retained counsel." });

    const linkedResult = await linked.redactBodyDetailed(body);
    const literalResult = await literal.redactBodyDetailed(body);

    expect(linkedResult.body).toBe(literalResult.body);
    expect(linkedResult.hits).toEqual([
      expect.objectContaining({ name: "organization", source: "fixture-detector", confidence: "high" }),
    ]);
    expect(linkedResult.ambiguousEntityLinks).toBe(0);
    expect(linked.restoreJson(linkedResult.body)).toBe(body);
  });

  it("retains a linked short alias across keyed turns without broadening its token boundary", async () => {
    let calls = 0;
    const detector: DetectorPlugin = {
      kind: "detector",
      name: "once-detector",
      bodyDetectionView: "content",
      detectText: () =>
        calls++ === 0
          ? [
              {
                name: "organization",
                value: "Northstar",
                source: "fixture-detector",
                kind: "pii",
                confidence: "high",
              } as const,
            ]
          : [],
    };
    const engine = new ProtectionEngine({
      plugins: [structuredRegistry([entityRecord("northstar", "Northstar Biologics Ltd")]), detector],
    });
    const scopeKey = "org:thread-linked-turns";
    await engine.beginRequest(scopeKey).redactBodyDetailed(JSON.stringify({ content: "Northstar signed." }));

    const repeated = await engine
      .beginRequest(scopeKey)
      .redactBodyDetailed(JSON.stringify({ content: "Later, NORTHSTAR approved." }));
    const embedded = await engine
      .beginRequest(scopeKey)
      .redactBodyDetailed(JSON.stringify({ content: "Northstarship remained public." }));

    expect(repeated.count).toBe(1);
    expect(repeated.body).not.toContain("NORTHSTAR");
    expect(repeated.ambiguousEntityLinks).toBe(0);
    expect(engine.beginRequest(scopeKey).restoreJson(repeated.body)).toContain("NORTHSTAR approved");
    expect(embedded.count).toBe(0);
    expect(embedded.body).toContain("Northstarship remained public");
  });

  it("does not report inferred ambiguity when an explicit registry form owns the range", async () => {
    const records = [
      entityRecord("northstar-biologics", "Northstar Biologics Ltd", [
        { formId: "northstar:short", value: "Northstar", kind: "short_name", boundary: "token" },
      ]),
      entityRecord("northstar-finance", "Northstar Finance LLC"),
    ];
    const engine = new ProtectionEngine({ plugins: [structuredRegistry(records), organizationDetector("Northstar")] });

    const result = await engine.redactBodyDetailed(JSON.stringify({ content: "Northstar retained counsel." }), {
      traceValues: true,
    });

    expect(result.ambiguousEntityLinks).toBe(0);
    expect(result.traceAmbiguousEntityLinks).toBeUndefined();
    expect(result.hits).toEqual([expect.objectContaining({ name: "managed-registry:northstar-biologics" })]);
  });
});

function entityRecord(
  entityId: string,
  canonicalValue: string,
  forms: RegisteredEntityProtection["forms"] = [],
  entityType: RegisteredEntityProtection["entityType"] = "organization",
): RegisteredEntityProtection {
  return {
    protectionKind: "entity",
    entityId,
    entityType,
    canonical: {
      formId: `${entityId}:canonical`,
      value: canonicalValue,
      kind: entityType === "organization" ? "legal_name" : "full_name",
    },
    forms,
    provenance: "registry",
    meta: {
      name: `managed-registry:${entityId}`,
      value: canonicalValue,
      source: "managed-registry-file",
      plugin: "structured-fixture",
      kind: "custom",
      confidence: "exact",
    },
  };
}

function entityClaim(record: RegisteredEntityProtection): EntityClaim {
  const claim = entityClaimsFromProtectionRecords([record])[0];
  if (!claim) throw new Error("missing fixture entity claim");
  return claim;
}

function detectedClaim(
  value: string,
  confidence: NonNullable<ProtectedValue["confidence"]>,
  name = "organization",
): EntityClaim {
  const claim = entityClaimsFromProtectionRecords(
    literalProtectionRecords(
      [{ name, value, source: "fixture-detector", plugin: "fixture-detector", kind: "pii", confidence }],
      "detected",
    ),
  )[0];
  if (!claim) throw new Error("missing fixture detected claim");
  return claim;
}

function organizationDetector(value: string): DetectorPlugin {
  return {
    kind: "detector",
    name: "fixture-detector",
    bodyDetectionView: "content",
    detectText: (text) => {
      const spans = [...text.matchAll(new RegExp(value, "g"))].map((match) => ({
        start: match.index,
        end: match.index + value.length,
      }));
      return spans.length > 0
        ? [{ name: "organization", value, source: "fixture-detector", kind: "pii", confidence: "high", spans }]
        : [];
    },
  };
}

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
