import type { ProtectedValue, ProtectionConfidence } from "./plugins/types.js";
import { RedactionInvariantError } from "./redaction-engine.js";

export type EntityAuthority = "registry" | "detected";
export type OccurrenceOrigin = "detector" | "expansion" | "clipped";

/** One logical protected thing; declared aliases/forms share the same stable identity and policy. */
export interface Entity {
  readonly id: string;
  readonly canonical: string;
  readonly forms: readonly string[];
  readonly authority: EntityAuthority;
  readonly meta: ProtectedValue;
}

/** One exact UTF-16 range in a redactable body leaf. */
export interface Occurrence {
  readonly leaf: number;
  readonly start: number;
  readonly end: number;
  readonly surface: string;
  readonly origin: OccurrenceOrigin;
  readonly entity: Entity;
}

/** A non-overlapping resolver output segment with one authoritative owner. */
export interface ResolvedOccurrence extends Occurrence {
  readonly clipped: boolean;
  readonly clippedBy?: EntityAuthority;
}

/** A detector occurrence expressed in the synthetic `leaves.join("\n")` coordinate space. */
export interface JoinedOccurrence {
  readonly start: number;
  readonly end: number;
  readonly origin: OccurrenceOrigin;
  readonly entity: Entity;
}

interface WinningSlice {
  source: Occurrence;
  start: number;
  end: number;
}

const AUTHORITY_RANK: Record<EntityAuthority, number> = { registry: 2, detected: 1 };
const CONFIDENCE_RANK: Record<ProtectionConfidence, number> = { exact: 3, high: 2, probabilistic: 1 };
const ORIGIN_RANK: Record<OccurrenceOrigin, number> = { detector: 3, expansion: 2, clipped: 1 };

/**
 * Resolve overlapping claims independently per leaf. The winning order is registry authority,
 * confidence, longer original span, earlier start, source, entity id, then origin. Losing claims keep
 * their non-overlapping, non-whitespace remainder, so the output covers every admitted sensitive
 * non-whitespace code unit without overlapping substitutions.
 */
export function resolveOccurrences(occurrences: readonly Occurrence[]): ResolvedOccurrence[] {
  if (occurrences.length === 0) return [];
  for (const occurrence of occurrences) validateOccurrence(occurrence);
  validateEntityIds(occurrences);

  const byLeaf = new Map<number, Occurrence[]>();
  for (const occurrence of occurrences) {
    const leaf = byLeaf.get(occurrence.leaf) ?? [];
    leaf.push(occurrence);
    byLeaf.set(occurrence.leaf, leaf);
  }

  const resolved: ResolvedOccurrence[] = [];
  for (const [leaf, claims] of [...byLeaf].sort(([a], [b]) => a - b)) {
    const boundaries = [...new Set(claims.flatMap((claim) => [claim.start, claim.end]))].sort((a, b) => a - b);
    const slices: WinningSlice[] = [];
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (start === undefined || end === undefined || start >= end) continue;
      const candidates = claims.filter((claim) => claim.start <= start && claim.end >= end);
      if (candidates.length === 0) continue;
      candidates.sort(comparePriority);
      const source = candidates[0];
      if (!source) continue;
      const previous = slices.at(-1);
      if (previous && previous.end === start && sameOccurrence(previous.source, source)) previous.end = end;
      else slices.push({ source, start, end });
    }

    for (const slice of slices) {
      const finalized = finalizeSlice(leaf, slice, claims);
      if (finalized) resolved.push(finalized);
    }
  }
  return resolved;
}

/**
 * Map one joined-view detector span back to full body-leaf indices. A span crossing a synthetic
 * newline is split into clipped leaf-local occurrences; the separator itself is never protected.
 */
export function mapJoinedOffsets(
  leaves: readonly string[],
  leafIndices: readonly number[],
  joined: JoinedOccurrence,
): Occurrence[] {
  if (leaves.length !== leafIndices.length) throw new Error("joined leaf indices must align with leaves");
  for (const index of leafIndices) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("joined leaf index must be a non-negative integer");
  }
  if (new Set(leafIndices).size !== leafIndices.length) throw new Error("joined leaf indices must be unique");

  const joinedLength = leaves.reduce((total, leaf) => total + leaf.length, Math.max(0, leaves.length - 1));
  if (
    !Number.isSafeInteger(joined.start) ||
    !Number.isSafeInteger(joined.end) ||
    joined.start < 0 ||
    joined.end <= joined.start ||
    joined.end > joinedLength
  ) {
    throw new Error("joined occurrence range is invalid");
  }

  const mapped: Occurrence[] = [];
  let base = 0;
  let mappedLength = 0;
  for (let i = 0; i < leaves.length; i++) {
    const text = leaves[i];
    const leaf = leafIndices[i];
    if (text === undefined || leaf === undefined) continue;
    const start = Math.max(joined.start, base);
    const end = Math.min(joined.end, base + text.length);
    if (start < end) {
      const localStart = start - base;
      const localEnd = end - base;
      mappedLength += localEnd - localStart;
      mapped.push({
        leaf,
        start: localStart,
        end: localEnd,
        surface: text.slice(localStart, localEnd),
        origin: joined.origin,
        entity: joined.entity,
      });
    }
    base += text.length + (i + 1 < leaves.length ? 1 : 0);
  }

  const wasClipped = mappedLength !== joined.end - joined.start;
  return wasClipped ? mapped.map((occurrence) => ({ ...occurrence, origin: "clipped" })) : mapped;
}

/** Splice one leaf from right to left after validating every resolved claim re-anchors exactly. */
export function spliceResolvedOccurrences(
  text: string,
  occurrences: readonly ResolvedOccurrence[],
  tokenFor: (occurrence: ResolvedOccurrence) => string,
): string {
  const ordered = [...occurrences].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  for (const occurrence of ordered) {
    if (
      occurrence.start < previousEnd ||
      occurrence.end > text.length ||
      text.slice(occurrence.start, occurrence.end) !== occurrence.surface
    ) {
      throw new RedactionInvariantError("resolved occurrence failed to re-anchor");
    }
    previousEnd = occurrence.end;
  }

  let out = text;
  for (const occurrence of ordered.reverse()) {
    out = `${out.slice(0, occurrence.start)}${tokenFor(occurrence)}${out.slice(occurrence.end)}`;
  }
  return out;
}

function finalizeSlice(
  leaf: number,
  slice: WinningSlice,
  claims: readonly Occurrence[],
): ResolvedOccurrence | undefined {
  const inherited = asResolved(slice.source);
  const newlyClipped = slice.start !== slice.source.start || slice.end !== slice.source.end;
  let start = slice.start;
  let end = slice.end;
  let surface = slice.source.surface.slice(start - slice.source.start, end - slice.source.start);

  if (newlyClipped) {
    const leading = surface.length - surface.trimStart().length;
    const trailing = surface.length - surface.trimEnd().length;
    start += leading;
    end -= trailing;
    surface = surface.slice(leading, surface.length - trailing);
  }
  if (!surface || start >= end) return undefined;

  const clipped = newlyClipped || inherited?.clipped === true || slice.source.origin === "clipped";
  const clippedBy = newlyClipped ? clippingAuthority(slice.source, claims) : inherited?.clippedBy;
  return {
    leaf,
    start,
    end,
    surface,
    origin: clipped ? "clipped" : slice.source.origin,
    entity: slice.source.entity,
    clipped,
    ...(clippedBy ? { clippedBy } : {}),
  };
}

function clippingAuthority(source: Occurrence, claims: readonly Occurrence[]): EntityAuthority | undefined {
  let authority: EntityAuthority | undefined;
  for (const candidate of claims) {
    if (sameOccurrence(candidate, source) || candidate.end <= source.start || candidate.start >= source.end) continue;
    if (comparePriority(candidate, source) >= 0) continue;
    if (!authority || AUTHORITY_RANK[candidate.entity.authority] > AUTHORITY_RANK[authority]) {
      authority = candidate.entity.authority;
    }
  }
  return authority;
}

/** Negative means `a` wins. Every field is safe metadata except span coordinates/surface length. */
function comparePriority(a: Occurrence, b: Occurrence): number {
  return (
    AUTHORITY_RANK[b.entity.authority] - AUTHORITY_RANK[a.entity.authority] ||
    confidenceRank(b.entity.meta.confidence) - confidenceRank(a.entity.meta.confidence) ||
    b.end - b.start - (a.end - a.start) ||
    a.start - b.start ||
    compareText(a.entity.meta.source, b.entity.meta.source) ||
    compareText(a.entity.id, b.entity.id) ||
    ORIGIN_RANK[b.origin] - ORIGIN_RANK[a.origin] ||
    compareText(a.surface, b.surface)
  );
}

function confidenceRank(confidence: ProtectionConfidence | undefined): number {
  return CONFIDENCE_RANK[confidence ?? "probabilistic"];
}

function sameOccurrence(a: Occurrence, b: Occurrence): boolean {
  return (
    a.leaf === b.leaf &&
    a.start === b.start &&
    a.end === b.end &&
    a.surface === b.surface &&
    a.origin === b.origin &&
    a.entity.id === b.entity.id
  );
}

function validateOccurrence(occurrence: Occurrence): void {
  if (!Number.isSafeInteger(occurrence.leaf) || occurrence.leaf < 0) {
    throw new Error("occurrence leaf must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(occurrence.start) ||
    !Number.isSafeInteger(occurrence.end) ||
    occurrence.start < 0 ||
    occurrence.end <= occurrence.start
  ) {
    throw new Error("occurrence range is invalid");
  }
  if (occurrence.surface.length !== occurrence.end - occurrence.start) {
    throw new Error("occurrence surface must re-anchor to its UTF-16 range");
  }
  if (!occurrence.entity.id || !occurrence.entity.canonical) throw new Error("occurrence entity identity is invalid");
}

function validateEntityIds(occurrences: readonly Occurrence[]): void {
  const identities = new Map<string, Pick<Entity, "canonical" | "authority">>();
  for (const { entity } of occurrences) {
    const existing = identities.get(entity.id);
    if (existing && (existing.canonical !== entity.canonical || existing.authority !== entity.authority)) {
      throw new Error("entity id has conflicting identity");
    }
    identities.set(entity.id, entity);
  }
}

function asResolved(occurrence: Occurrence): ResolvedOccurrence | undefined {
  const candidate = occurrence as Partial<ResolvedOccurrence>;
  return typeof candidate.clipped === "boolean" ? (occurrence as ResolvedOccurrence) : undefined;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
