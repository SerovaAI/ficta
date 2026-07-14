import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hexSurrogateStrategy, typedSurrogateStrategy } from "../src/engine/surrogate.js";

export type SurrogateStyle = "opaque" | "typed" | "entity-family";
export type EntityType = "ORG" | "PERSON";

export interface EntityFixtureRecord {
  id: string;
  type: EntityType;
  surfaces: string[];
}

export interface LiteralFixtureRecord {
  type: string;
  value: string;
}

export interface EntityFidelityFixture {
  name: string;
  protectionContextId: string;
  documentLines: string[];
  entities: EntityFixtureRecord[];
  literals: LiteralFixtureRecord[];
  mustRemainVisible: string[];
  evaluation: {
    clientSurface: string;
    counterpartySurface: string;
    supplierDutySurface: string;
    noticeSenderSurface: string;
    facts: {
      damagesCap: string;
      curePeriod: string;
      interestRate: string;
      noticeDate: string;
      arbitrationDuration: string;
    };
  };
}

export interface SurrogateMapping {
  kind: "entity" | "literal";
  surface: string;
  token: string;
  type: string;
  entityId?: string;
  entityTag?: string;
  surfaceTag?: string;
}

export interface RenderedFixture {
  style: SurrogateStyle;
  sourceText: string;
  text: string;
  mappings: SurrogateMapping[];
}

export interface OfflineCharacterization {
  style: SurrogateStyle;
  distinctTokens: number;
  protectedSurfacesAbsent: boolean;
  materialFactsVisible: boolean;
  exactRoundTrip: boolean;
  entityFamilyConsistency: "not-applicable" | boolean;
}

const FIXTURE_URL = new URL("./fixtures/entity-surrogate-fidelity.json", import.meta.url);
const EVALUATION_KEY = "phase-zero-entity-fidelity-key-at-least-32-bytes";
const SURROGATE_LIKE = /FICTA_[A-Za-z0-9_]+/gu;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export async function loadEntityFidelityFixture(): Promise<EntityFidelityFixture> {
  const parsed = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as EntityFidelityFixture;
  validateFixture(parsed);
  return parsed;
}

/**
 * Render the synthetic fixture using the two shipped strategies or the candidate family shape.
 * This is characterization-only code under bench/: it does not add the candidate strategy to the
 * engine, token recognizers, or provider-visible production paths.
 */
export function renderEntityFidelityFixture(fixture: EntityFidelityFixture, style: SurrogateStyle): RenderedFixture {
  const sourceText = fixture.documentLines.join("\n");
  const mappings: SurrogateMapping[] = [];
  const currentStrategy =
    style === "typed" ? typedSurrogateStrategy(EVALUATION_KEY) : hexSurrogateStrategy(EVALUATION_KEY);

  for (const entity of fixture.entities) {
    for (const surface of entity.surfaces) {
      if (style === "entity-family") {
        const entityTag = hmacBase32(canonicalEncode("ficta.entity.v1", fixture.protectionContextId, entity.id));
        const surfaceTag = hmacBase32(
          canonicalEncode("ficta.surface.v1", fixture.protectionContextId, entity.id, surface),
        );
        mappings.push({
          kind: "entity",
          surface,
          token: `FICTA_${entity.type}_${entityTag}_${surfaceTag}`,
          type: entity.type,
          entityId: entity.id,
          entityTag,
          surfaceTag,
        });
      } else {
        mappings.push({
          kind: "entity",
          surface,
          token: currentStrategy.mint(surface, {
            name: entity.type === "ORG" ? "organization" : "person",
            kind: "pii",
          }),
          type: entity.type,
          entityId: entity.id,
        });
      }
    }
  }

  for (const literal of fixture.literals) {
    mappings.push({
      kind: "literal",
      surface: literal.value,
      token: currentStrategy.mint(literal.value, {
        name: literal.type === "ACCOUNT" ? "iban-code" : undefined,
        kind: "secret",
      }),
      type: literal.type,
    });
  }

  assertUniqueMappings(mappings);
  const ordered = [...mappings].sort((left, right) => right.surface.length - left.surface.length);
  let text = sourceText;
  for (const mapping of ordered) text = text.split(mapping.surface).join(mapping.token);
  return { style, sourceText, text, mappings };
}

export function characterizeRenderedFixture(
  fixture: EntityFidelityFixture,
  rendered: RenderedFixture,
): OfflineCharacterization {
  const entityFamilyConsistency =
    rendered.style === "entity-family"
      ? fixture.entities.every((entity) => {
          const mappings = rendered.mappings.filter((mapping) => mapping.entityId === entity.id);
          return (
            new Set(mappings.map((mapping) => mapping.entityTag)).size === 1 &&
            new Set(mappings.map((mapping) => mapping.surfaceTag)).size === mappings.length
          );
        })
      : "not-applicable";

  return {
    style: rendered.style,
    distinctTokens: new Set(rendered.mappings.map((mapping) => mapping.token)).size,
    protectedSurfacesAbsent: rendered.mappings.every((mapping) => !rendered.text.includes(mapping.surface)),
    materialFactsVisible: fixture.mustRemainVisible.every((value) => rendered.text.includes(value)),
    exactRoundTrip: restoreText(rendered.text, rendered.mappings) === rendered.sourceText,
    entityFamilyConsistency,
  };
}

export function tokenForSurface(rendered: RenderedFixture, surface: string): string {
  const token = rendered.mappings.find((mapping) => mapping.surface === surface)?.token;
  if (!token) throw new Error(`No surrogate mapping for ${JSON.stringify(surface)}`);
  return token;
}

export function entityIdForToken(rendered: RenderedFixture, token: string): string | undefined {
  return rendered.mappings.find((mapping) => mapping.token === token)?.entityId;
}

export function restoreText(text: string, mappings: readonly SurrogateMapping[]): string {
  let restored = text;
  const ordered = [...mappings].sort((left, right) => right.token.length - left.token.length);
  for (const mapping of ordered) restored = restored.split(mapping.token).join(mapping.surface);
  return restored;
}

/** Model the production stream invariant for the candidate shape: incomplete known tokens wait. */
export function restoreFragmented(chunks: readonly string[], mappings: readonly SurrogateMapping[]): string {
  const tokens = mappings.map((mapping) => mapping.token);
  const maxLength = Math.max(...tokens.map((token) => token.length));
  let pending = "";
  let output = "";
  for (const chunk of chunks) {
    pending += chunk;
    const inspectFrom = Math.max(0, pending.length - maxLength + 1);
    let holdFrom: number | undefined;
    for (let index = inspectFrom; index < pending.length; index += 1) {
      const suffix = pending.slice(index);
      if (tokens.some((token) => token.startsWith(suffix))) {
        holdFrom = index;
        break;
      }
    }
    const flushTo = holdFrom ?? pending.length;
    output += restoreText(pending.slice(0, flushTo), mappings);
    pending = pending.slice(flushTo);
  }
  return output + restoreText(pending, mappings);
}

export function mutateToken(token: string): string {
  const last = token.at(-1);
  if (!last) throw new Error("Cannot mutate an empty token");
  return `${token.slice(0, -1)}${last === "A" || last === "a" ? "B" : "A"}`;
}

export function surrogateLikeTokens(text: string): string[] {
  return [...text.matchAll(SURROGATE_LIKE)].map((match) => match[0]);
}

function hmacBase32(payload: Uint8Array): string {
  const digest = createHmac("sha256", EVALUATION_KEY).update(payload).digest();
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
      if (output.length === 12) return output;
    }
  }
  throw new Error("HMAC digest was too short for a 12-character base32 tag");
}

function canonicalEncode(...fields: string[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function assertUniqueMappings(mappings: readonly SurrogateMapping[]): void {
  const surfaces = new Set<string>();
  const tokens = new Map<string, string>();
  const entityTags = new Map<string, string>();
  for (const mapping of mappings) {
    if (surfaces.has(mapping.surface)) throw new Error(`Fixture repeats surface ${JSON.stringify(mapping.surface)}`);
    surfaces.add(mapping.surface);
    const prior = tokens.get(mapping.token);
    if (prior && prior !== mapping.surface) {
      throw new Error(`Surrogate collision between ${JSON.stringify(prior)} and ${JSON.stringify(mapping.surface)}`);
    }
    tokens.set(mapping.token, mapping.surface);
    if (mapping.entityTag && mapping.entityId) {
      const priorEntity = entityTags.get(mapping.entityTag);
      if (priorEntity && priorEntity !== mapping.entityId) {
        throw new Error(
          `Entity-tag collision between ${JSON.stringify(priorEntity)} and ${JSON.stringify(mapping.entityId)}`,
        );
      }
      entityTags.set(mapping.entityTag, mapping.entityId);
    }
  }
}

function validateFixture(fixture: EntityFidelityFixture): void {
  if (!fixture.name || !fixture.protectionContextId || fixture.documentLines.length === 0) {
    throw new Error("Entity fidelity fixture is missing its name, context, or document");
  }
  const sourceText = fixture.documentLines.join("\n");
  for (const entity of fixture.entities) {
    if (!entity.id || !["ORG", "PERSON"].includes(entity.type) || entity.surfaces.length === 0) {
      throw new Error(`Invalid entity fixture record ${JSON.stringify(entity.id)}`);
    }
    for (const surface of entity.surfaces) {
      if (!sourceText.includes(surface))
        throw new Error(`Document is missing entity surface ${JSON.stringify(surface)}`);
    }
  }
  for (const literal of fixture.literals) {
    if (!sourceText.includes(literal.value))
      throw new Error(`Document is missing literal ${JSON.stringify(literal.value)}`);
  }
  for (const fact of fixture.mustRemainVisible) {
    if (!sourceText.includes(fact)) throw new Error(`Document is missing legal-fidelity fact ${JSON.stringify(fact)}`);
  }
}
