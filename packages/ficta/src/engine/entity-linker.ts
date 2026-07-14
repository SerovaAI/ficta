import type { AmbiguousEntityLink, Entity, EntityClaim } from "./occurrence.js";

const ORGANIZATION_LABEL = "organization";
const ORGANIZATION_SHORT_NAME_RULE = "organization_short_name";
const LEGAL_ENTITY_DESIGNATORS = new Set([
  "ab",
  "ag",
  "as",
  "bv",
  "cc",
  "company",
  "corp",
  "corporation",
  "fzc",
  "fzco",
  "gmbh",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "nv",
  "oy",
  "plc",
  "pte",
  "pty",
  "sa",
  "sarl",
  "sas",
  "spa",
  "srl",
]);
const LEXICAL_WORD_RE = /^[\p{L}\p{M}\p{N}]+(?:['’.-][\p{L}\p{M}\p{N}]+)*$/u;
const LEXICAL_WORDS_RE = /[\p{L}\p{M}\p{N}]+(?:['’.-][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Attach admitted detector organization aliases to durable registry anchors only when the short-key
 * rule yields exactly one entity. Identity changes; detector trust and metadata deliberately do not.
 */
export function linkDetectedEntityClaims(
  registryClaims: readonly EntityClaim[],
  detectedClaims: readonly EntityClaim[],
): EntityClaim[] {
  const anchors = organizationAnchorIndex(registryClaims);
  return detectedClaims.map((claim) => linkDetectedClaim(claim, anchors));
}

function linkDetectedClaim(claim: EntityClaim, anchors: ReadonlyMap<string, readonly Entity[]>): EntityClaim {
  if (!isEligibleOrganizationMention(claim)) return claim;
  const key = detectedShortKey(claim.meta.value);
  if (!key) return claim;
  const candidates = anchors.get(key) ?? [];
  if (candidates.length === 1) {
    const entity = candidates[0];
    if (!entity) return claim;
    return {
      entity,
      meta: claim.meta,
      mention: {
        ...claim.mention,
        linkSource: "deterministic_alias",
        linkConfidence: "high",
      },
    };
  }
  if (candidates.length < 2) return claim;
  const ambiguousEntityLink: AmbiguousEntityLink = {
    code: "AMBIGUOUS_ENTITY_LINK",
    linkingRule: ORGANIZATION_SHORT_NAME_RULE,
    candidateEntityIds: candidates.map((candidate) => candidate.id),
  };
  return { ...claim, ambiguousEntityLink };
}

function isEligibleOrganizationMention(claim: EntityClaim): boolean {
  return (
    claim.mention.detectionSource === "detector" &&
    claim.mention.resolverAuthority === "detected" &&
    (claim.mention.detectionConfidence === "exact" || claim.mention.detectionConfidence === "high") &&
    normalizedCategory(claim.meta.name) === ORGANIZATION_LABEL
  );
}

function organizationAnchorIndex(claims: readonly EntityClaim[]): Map<string, Entity[]> {
  const byKey = new Map<string, Map<string, Entity>>();
  for (const claim of claims) {
    const { entity } = claim;
    if (
      entity.protectionKind !== "entity" ||
      entity.provenance !== "registry" ||
      entity.entityType !== "organization"
    ) {
      continue;
    }
    for (const value of [entity.canonical, ...entity.forms.map((form) => form.value)]) {
      const key = registeredShortKey(value);
      if (!key) continue;
      const entities = byKey.get(key) ?? new Map<string, Entity>();
      entities.set(entity.id, entity);
      byKey.set(key, entities);
    }
  }
  return new Map(
    [...byKey].map(([key, entities]) => [key, [...entities.values()].sort((a, b) => a.id.localeCompare(b.id))]),
  );
}

function detectedShortKey(value: string): string | undefined {
  const normalized = normalizeEntityForm(value);
  return LEXICAL_WORD_RE.test(normalized) ? normalized : undefined;
}

function registeredShortKey(value: string): string | undefined {
  const words = normalizeEntityForm(value).match(LEXICAL_WORDS_RE) ?? [];
  if (words[0] === "the") words.shift();
  while (words.length > 0 && LEGAL_ENTITY_DESIGNATORS.has(words.at(-1) ?? "")) words.pop();
  return words[0];
}

function normalizeEntityForm(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function normalizedCategory(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}
