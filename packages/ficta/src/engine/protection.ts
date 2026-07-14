import { createHash } from "node:crypto";
import type { Entity, EntityClaim, EntityForm, EntityFormBoundary, MentionTrust } from "./occurrence.js";
import type { ProtectedValue, ProtectionConfidence } from "./plugins/types.js";

export interface LiteralProtection {
  readonly protectionKind: "literal";
  /** Durable registry id when one exists; value-derived for public ProtectedValue adapters. */
  readonly protectionId: string;
  readonly value: string;
  readonly semanticType?: string;
  readonly authority: "registry" | "detected";
  readonly confidence: ProtectionConfidence;
  readonly meta: ProtectedValue;
}

export interface RegisteredEntityCanonicalForm {
  readonly formId: string;
  readonly value: string;
  readonly kind?: "legal_name" | "full_name" | "short_name" | "alias";
}

export interface RegisteredEntityForm extends RegisteredEntityCanonicalForm {
  readonly boundary: EntityFormBoundary;
}

export interface RegisteredEntityProtection {
  readonly protectionKind: "entity";
  readonly entityId: string;
  readonly entityType: "organization" | "person";
  /** Canonical values always retain the shipped unbounded-substring matching policy. */
  readonly canonical: RegisteredEntityCanonicalForm;
  readonly forms: readonly RegisteredEntityForm[];
  readonly provenance: "registry";
  readonly meta: ProtectedValue;
}

export type ProtectionRecord = LiteralProtection | RegisteredEntityProtection;

/** Built-in-only structured ingress, deliberately absent from the public RegistrySourcePlugin API. */
export interface StructuredRegistrySourceCapabilities {
  loadProtectionRecords(): readonly ProtectionRecord[];
  /** Invalid content prevents startup instead of degrading to discovery-only. */
  fatalLoadErrors?: boolean;
}

/** Preserve the public ProtectedValue contract while normalizing it into the richer internal model. */
export function literalProtectionRecords(
  values: readonly ProtectedValue[],
  authority: LiteralProtection["authority"],
): LiteralProtection[] {
  const byValue = new Map<string, ProtectedValue>();
  for (const value of values) if (value.value && !byValue.has(value.value)) byValue.set(value.value, value);
  return [...byValue].map(([value, meta]) => ({
    protectionKind: "literal",
    protectionId: `${authority}:${valueHash(value)}`,
    value,
    authority,
    confidence: meta.confidence ?? "probabilistic",
    meta,
  }));
}

/** Flatten one logical protection record into the exact surfaces registered with the vault. */
export function protectionRecordSurfaces(record: ProtectionRecord): ProtectedValue[] {
  if (record.protectionKind === "literal") return [{ ...record.meta, value: record.value }];
  return [record.canonical, ...record.forms].map((form) => ({
    ...record.meta,
    value: form.value,
  }));
}

/** Build range-claim inputs without placing resolver trust on the parent entity identity. */
export function entityClaimsFromProtectionRecords(records: readonly ProtectionRecord[]): EntityClaim[] {
  return records.map((record) => {
    if (record.protectionKind === "literal") return literalClaim(record);
    const entity: Entity = {
      id: record.entityId,
      protectionKind: "entity",
      provenance: record.provenance,
      entityType: record.entityType,
      canonical: record.canonical.value,
      forms: dedupeForms(record.forms),
    };
    return {
      entity,
      meta: record.meta,
      mention: {
        detectionSource: "registry",
        detectionConfidence: record.meta.confidence ?? "exact",
        linkSource: "explicit_form",
        linkConfidence: "exact",
        resolverAuthority: "registry",
        protectionEligible: true,
      },
    };
  });
}

function literalClaim(record: LiteralProtection): EntityClaim {
  const mention: MentionTrust = {
    detectionSource: record.authority === "registry" ? "registry" : "detector",
    detectionConfidence: record.confidence,
    linkSource: "none",
    resolverAuthority: record.authority,
    protectionEligible: true,
  };
  return {
    entity: {
      id: record.protectionId,
      protectionKind: "literal",
      provenance: record.authority === "registry" ? "registry" : "detector",
      canonical: record.value,
      forms: [],
    },
    meta: record.meta,
    mention,
  };
}

function dedupeForms(forms: readonly RegisteredEntityForm[]): EntityForm[] {
  const byValue = new Map<string, EntityForm>();
  for (const form of forms) {
    if (!form.value) continue;
    const existing = byValue.get(form.value);
    if (!existing || existing.boundary === "token") {
      byValue.set(form.value, { value: form.value, boundary: form.boundary });
    }
  }
  return [...byValue.values()];
}

function valueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
