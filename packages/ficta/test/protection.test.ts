import { describe, expect, it } from "vitest";
import { expandEntities } from "../src/engine/expander.js";
import { resolveOccurrences } from "../src/engine/occurrence.js";
import {
  entityClaimsFromProtectionRecords,
  literalProtectionRecords,
  type RegisteredEntityProtection,
} from "../src/engine/protection.js";
import type { ProtectedValue } from "../src/plugins/index.js";

describe("internal protection records", () => {
  it("adapts public ProtectedValue inputs into behavior-compatible literal claims", () => {
    const value: ProtectedValue = {
      name: "CLIENT",
      value: "Northstar Biologics (Pty) Ltd",
      source: "managed-registry-file",
      kind: "secret",
      confidence: "exact",
    };
    const duplicate = { ...value, name: "DUPLICATE" };
    const records = literalProtectionRecords([value, duplicate], "registry");
    const claims = entityClaimsFromProtectionRecords(records);

    expect(records).toEqual([
      {
        protectionKind: "literal",
        protectionId: expect.stringMatching(/^registry:[0-9a-f]{64}$/u),
        value: value.value,
        authority: "registry",
        confidence: "exact",
        meta: value,
      },
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      entity: {
        id: expect.stringMatching(/^registry:[0-9a-f]{64}$/u),
        protectionKind: "literal",
        provenance: "registry",
        canonical: value.value,
        forms: [],
      },
      meta: value,
      mention: {
        detectionSource: "registry",
        detectionConfidence: "exact",
        linkSource: "none",
        resolverAuthority: "registry",
        protectionEligible: true,
      },
    });
  });

  it("preserves probabilistic overlap ranking when a registry value omits confidence", () => {
    const records = literalProtectionRecords(
      [
        {
          name: "EXTERNAL_WIDE",
          value: "Northstar Holdings",
          source: "third-party-registry",
          kind: "custom",
        },
        {
          name: "EXTERNAL_HIGH",
          value: "Northstar",
          source: "third-party-registry",
          kind: "custom",
          confidence: "high",
        },
      ],
      "registry",
    );
    expect(records[0]?.confidence).toBe("probabilistic");

    const resolved = resolveOccurrences(
      expandEntities(["Northstar Holdings"], entityClaimsFromProtectionRecords(records)),
    );
    expect(
      resolved.map(({ surface, meta, mention }) => ({
        surface,
        name: meta.name,
        confidence: mention.detectionConfidence,
      })),
    ).toEqual([
      { surface: "Northstar", name: "EXTERNAL_HIGH", confidence: "high" },
      { surface: "Holdings", name: "EXTERNAL_WIDE", confidence: "probabilistic" },
    ]);
  });

  it("represents a structured entity and expands all forms under one identity in fixtures", () => {
    const record: RegisteredEntityProtection = {
      protectionKind: "entity",
      entityId: "entity:northstar",
      entityType: "organization",
      canonical: {
        formId: "form:legal",
        value: "Northstar Biologics (Pty) Ltd",
        kind: "legal_name",
      },
      forms: [
        {
          formId: "form:short",
          value: "Northstar",
          kind: "short_name",
          boundary: "token",
        },
      ],
      provenance: "registry",
      meta: {
        name: "CLIENT",
        value: "Northstar Biologics (Pty) Ltd",
        source: "structured-fixture",
        kind: "pii",
        confidence: "exact",
      },
    };
    const [claim] = entityClaimsFromProtectionRecords([record]);
    expect(claim).toBeDefined();
    if (!claim) return;

    const occurrences = resolveOccurrences(
      expandEntities(["Northstar Biologics (Pty) Ltd retained counsel. Northstar approved."], [claim]),
    );
    expect(occurrences.map(({ surface, entity }) => ({ surface, id: entity.id }))).toEqual([
      { surface: "Northstar Biologics (Pty) Ltd", id: record.entityId },
      { surface: "Northstar", id: record.entityId },
    ]);
    expect(occurrences.every((occurrence) => occurrence.mention.linkSource === "explicit_form")).toBe(true);
  });
});
