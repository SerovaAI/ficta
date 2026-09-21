/**
 * Client-safe types for the optional pre-send second opinion. The judgement itself runs in
 * `second-opinion.server.ts`; this module only describes the result the browser renders and never
 * imports the vendor SDK.
 *
 * A second opinion is advisory. It labels detected findings and flags lines the detectors may have
 * missed; it never changes what is redacted. The user selects any value it points at through the
 * existing "Protect in chat" path, which re-previews and mints a fresh ticket.
 */

export const SECOND_OPINION_KINDS = [
  "credential",
  "placeholder",
  "identifier",
  "hash_or_digest",
  "path_or_url",
  "encoded_data",
  "person",
  "organization",
  "role_or_legal_term",
  "commercial_fact",
  "other",
] as const;

export type SecondOpinionKind = (typeof SECOND_OPINION_KINDS)[number];

export type SecondOpinionStatus = "ok" | "skipped" | "unavailable";

export interface SecondOpinionFindingLabel {
  /** Inclusive UTF-16 offset into the reviewed text; matches the preview finding it labels. */
  start: number;
  /** Exclusive UTF-16 offset into the reviewed text. */
  end: number;
  kind: SecondOpinionKind;
  /** Vendor-reported confidence in `kind`, 0–1. */
  confidence: number;
}

export interface SecondOpinionLine {
  /** Zero-based line index in the reviewed text. */
  line: number;
  /** Inclusive UTF-16 offset of the line start in the reviewed text. */
  start: number;
  /** Exclusive UTF-16 offset of the line end (before the newline). */
  end: number;
  /** Probability the line names a party or one of their identifiers that is not yet protected. */
  party: number;
  /** Probability the line states a commercial term tied to a named party. */
  fact: number;
}

export interface SecondOpinion {
  status: SecondOpinionStatus;
  /** Short machine reason for `skipped` or `unavailable`; never contains message text. */
  reason?: string;
  /** Vendor model that produced an `ok` result. */
  model?: string;
  /** Advisory labels for detected findings only. Registry and user findings are never judged. */
  findings: SecondOpinionFindingLabel[];
  /** Lines flagged above the review threshold, in document order. */
  lines: SecondOpinionLine[];
}

/** Secret-free availability resolved server-side for the admin toggle. */
export interface SecondOpinionAvailability {
  /** A TypeSafe API key is configured on the server. */
  available: boolean;
  /** `FICTA_GATEWAY_SECOND_OPINION` forces the state; the admin setting is then read-only. */
  pinned?: "on" | "off";
}

export const SECOND_OPINION_KIND_LABELS: Record<SecondOpinionKind, string> = {
  credential: "credential",
  placeholder: "placeholder value",
  identifier: "code identifier",
  hash_or_digest: "content hash",
  path_or_url: "path or URL",
  encoded_data: "encoded data",
  person: "person",
  organization: "organisation",
  role_or_legal_term: "role or legal term",
  commercial_fact: "commercial term",
  other: "unclear",
};

export function secondOpinionKindLabel(kind: SecondOpinionKind): string {
  return SECOND_OPINION_KIND_LABELS[kind];
}

export function flaggedLineCount(opinion: SecondOpinion | undefined): number {
  return opinion?.status === "ok" ? opinion.lines.length : 0;
}

export function secondOpinionLabelFor(
  opinion: SecondOpinion | undefined,
  start: number,
  end: number,
): SecondOpinionFindingLabel | undefined {
  if (opinion?.status !== "ok") return undefined;
  return opinion.findings.find((label) => label.start === start && label.end === end);
}

/** Structural check for the browser: the route's response is trusted, but the shape is verified. */
export function isSecondOpinion(value: unknown): value is SecondOpinion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "ok" && record.status !== "skipped" && record.status !== "unavailable") return false;
  if (record.reason !== undefined && typeof record.reason !== "string") return false;
  if (record.model !== undefined && typeof record.model !== "string") return false;
  if (!Array.isArray(record.findings) || !record.findings.every(isFindingLabel)) return false;
  return Array.isArray(record.lines) && record.lines.every(isLine);
}

function isFindingLabel(value: unknown): value is SecondOpinionFindingLabel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isOffset(record.start) &&
    isOffset(record.end) &&
    record.end > record.start &&
    SECOND_OPINION_KINDS.includes(record.kind as SecondOpinionKind) &&
    isUnit(record.confidence)
  );
}

function isLine(value: unknown): value is SecondOpinionLine {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isOffset(record.line) &&
    isOffset(record.start) &&
    isOffset(record.end) &&
    record.end >= record.start &&
    isUnit(record.party) &&
    isUnit(record.fact)
  );
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
