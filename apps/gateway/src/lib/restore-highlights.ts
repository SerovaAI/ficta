import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_ORIGIN,
  FICTA_RESTORE_HIGHLIGHT_START,
  type ProtectionPreviewFinding,
  type ProtectionPreviewOrigin,
} from "@serovaai/ficta-protocol";

export const FICTA_PROTECTION_METADATA_KEY = "fictaProtection";

export type ProtectionHighlightDirection = "redacted" | "restored";

/** Durable, values-free display evidence attached to a TanStack text part. Coordinates are UTF-16. */
export interface ProtectionHighlightAnnotation {
  start: number;
  end: number;
  surrogate: string;
  origin: ProtectionPreviewOrigin;
  direction: ProtectionHighlightDirection;
}

export interface ProtectionTextSegment {
  text: string;
  annotation?: ProtectionHighlightAnnotation;
}

export function protectionHighlightTag(
  direction: ProtectionHighlightDirection,
  origin: ProtectionPreviewOrigin,
): string {
  return `ficta-protection-${direction}-${origin}`;
}

export type RestoreHighlightDisplayMode = "values" | "surrogates";

/** One restored PII span the proxy highlighted: its real `value`, the `surrogate` the
 * model actually saw. This is the structured, in-memory display metadata — the delimiter markers it is
 * parsed from never live past {@link parseRestoreHighlightText}. */
export interface RestoreHighlight {
  value: string;
  surrogate: string;
  /** Protection source selected by the proxy's winning vault layer. */
  origin: ProtectionPreviewOrigin;
}

/** The result of parsing marker-bearing streamed text into display metadata: the clean text to show and
 * the restorations to highlight within it. Only `visibleText` is ever persisted; `restorations` stay
 * memory-only (see `use-restore-highlight-display.ts`). */
export interface ParsedRestoreText {
  visibleText: string;
  restorations: RestoreHighlight[];
}

/** Convert authoritative outbound preview findings into the minimal metadata persisted with a user turn. */
export function previewFindingsToAnnotations(
  text: string,
  findings: readonly ProtectionPreviewFinding[],
): ProtectionHighlightAnnotation[] {
  return normalizeProtectionAnnotations(
    text,
    findings.map(({ start, end, surrogate, origin }) => ({
      start,
      end,
      surrogate,
      origin,
      direction: "redacted",
    })),
  );
}

/** Convert ephemeral restore values into values-free coordinates for display/persistence. */
export function restorationsToAnnotations(
  visibleText: string,
  restorations: readonly RestoreHighlight[],
): ProtectionHighlightAnnotation[] {
  return normalizeProtectionAnnotations(
    visibleText,
    locateRestorationSpans(visibleText, restorations).map(({ start, end, restoration }) => ({
      start,
      end,
      surrogate: restoration.surrogate,
      origin: restoration.origin,
      direction: "restored",
    })),
  );
}

/** Read and validate the namespaced display metadata on a text part. Invalid evidence is ignored. */
export function protectionAnnotationsFromPart(
  part: unknown,
  expectedDirection?: ProtectionHighlightDirection,
): ProtectionHighlightAnnotation[] {
  const record = asRecord(part);
  if (record?.type !== "text" || typeof record.content !== "string") return [];
  const metadata = asRecord(record.metadata);
  const annotations = normalizeProtectionAnnotations(record.content, metadata?.[FICTA_PROTECTION_METADATA_KEY]);
  return expectedDirection
    ? annotations.filter((annotation) => annotation.direction === expectedDirection)
    : annotations;
}

/** Attach validated annotations while preserving unrelated TanStack/provider metadata. */
export function withProtectionAnnotations<T>(part: T, annotations: readonly ProtectionHighlightAnnotation[]): T {
  const record = asRecord(part);
  if (record?.type !== "text" || typeof record.content !== "string") return part;
  const normalized = normalizeProtectionAnnotations(record.content, annotations);
  const existingMetadata = asRecord(record.metadata) ?? {};
  if (normalized.length === 0 && !(FICTA_PROTECTION_METADATA_KEY in existingMetadata)) return part;

  const metadata = { ...existingMetadata };
  if (normalized.length > 0) metadata[FICTA_PROTECTION_METADATA_KEY] = normalized;
  else delete metadata[FICTA_PROTECTION_METADATA_KEY];

  const next = { ...record };
  if (Object.keys(metadata).length > 0) next.metadata = metadata;
  else delete next.metadata;
  return next as T;
}

/** Stable visible segments for plain-text user bubbles and the send-review preview. */
export function protectionTextSegments(
  text: string,
  annotations: readonly ProtectionHighlightAnnotation[],
  displayMode: RestoreHighlightDisplayMode = "values",
): ProtectionTextSegment[] {
  const normalized = normalizeProtectionAnnotations(text, annotations);
  if (normalized.length === 0) return [{ text }];
  const segments: ProtectionTextSegment[] = [];
  let cursor = 0;
  for (const annotation of normalized) {
    if (annotation.start > cursor) segments.push({ text: text.slice(cursor, annotation.start) });
    segments.push({
      text: displayMode === "surrogates" ? annotation.surrogate : text.slice(annotation.start, annotation.end),
      annotation,
    });
    cursor = annotation.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/**
 * Validate untrusted/hydrated annotations against the current text. Sorting and overlap rejection mirror
 * the preview renderer: for equal starts, the longest authoritative span wins.
 */
export function normalizeProtectionAnnotations(text: string, input: unknown): ProtectionHighlightAnnotation[] {
  if (!Array.isArray(input)) return [];
  const candidates: ProtectionHighlightAnnotation[] = [];
  for (const entry of input) {
    const value = asRecord(entry);
    if (!value) continue;
    const { start, end, surrogate, origin, direction } = value;
    const normalizedOrigin = typeof origin === "string" && isProtectionOrigin(origin) ? origin : undefined;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number) ||
      (end as number) > text.length ||
      typeof surrogate !== "string" ||
      !isSurrogateToken(surrogate) ||
      !normalizedOrigin ||
      (direction !== "redacted" && direction !== "restored")
    ) {
      continue;
    }
    candidates.push({
      start: start as number,
      end: end as number,
      surrogate,
      origin: normalizedOrigin,
      direction,
    });
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const normalized: ProtectionHighlightAnnotation[] = [];
  let cursor = 0;
  for (const annotation of candidates) {
    if (annotation.start < cursor) continue;
    normalized.push(annotation);
    cursor = annotation.end;
  }
  return normalized;
}

export function hasRestoreHighlightMarkers(content: string): boolean {
  return content.includes(FICTA_RESTORE_HIGHLIGHT_START) || content.includes(FICTA_RESTORE_HIGHLIGHT_END);
}

/**
 * Parse marker-bearing streamed assistant text into a structured sidecar: the clean `visibleText` (real
 * values substituted, markers removed — identical to what {@link stripRestoreHighlightMarkers} produces)
 * plus the ordered, de-duplicated list of `{ value, surrogate, origin }` restorations. This is the single client
 * boundary where the in-band delimiter format is consumed; nothing downstream sees markers.
 *
 * Incomplete markers mid-stream are handled like the strip path — a trailing partial marker or an
 * incomplete surrogate/metadata prefix contributes no visible text and no restoration until it completes.
 */
export function parseRestoreHighlightText(content: string): ParsedRestoreText {
  let visibleText = "";
  const restorations: RestoreHighlight[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  for (;;) {
    const start = content.indexOf(FICTA_RESTORE_HIGHLIGHT_START, cursor);
    if (start === -1) {
      visibleText += stripTrailingMarkerPrefix(stripOrphanEndMarkers(content.slice(cursor)));
      return { visibleText, restorations };
    }

    visibleText += stripOrphanEndMarkers(content.slice(cursor, start));
    const valueStart = start + FICTA_RESTORE_HIGHLIGHT_START.length;
    const end = content.indexOf(FICTA_RESTORE_HIGHLIGHT_END, valueStart);
    const payload = end === -1 ? stripTrailingMarkerPrefix(content.slice(valueStart)) : content.slice(valueStart, end);
    const parsed = parseHighlightPayload(payload);
    visibleText += parsed.value;

    // Only complete markers (END seen) with a non-empty value are real restorations; a partial marker at
    // the stream tail is left for the next chunk. De-dupe by value so a value repeated in one turn is
    // located once and highlighted at every occurrence at render time.
    if (end !== -1 && parsed.value && parsed.surrogate && parsed.origin && !seen.has(parsed.value)) {
      seen.add(parsed.value);
      restorations.push({
        value: parsed.value,
        surrogate: parsed.surrogate,
        origin: parsed.origin,
      });
    }

    if (end === -1) return { visibleText, restorations };
    cursor = end + FICTA_RESTORE_HIGHLIGHT_END.length;
  }
}

interface RestorationSpan {
  start: number;
  end: number;
  restoration: RestoreHighlight;
}

/**
 * Locate each restoration's `value` occurrences in `visibleText`, longest value first so a shorter value
 * cannot claim characters inside a longer one, skipping any range already claimed. Matching by occurrence
 * (rather than stored offsets) is what makes highlights robust to the benign streamed-vs-finished text
 * drift that the old exact-equality cache could not survive: if a value no longer appears, it simply is
 * not highlighted.
 */
function locateRestorationSpans(visibleText: string, restorations: readonly RestoreHighlight[]): RestorationSpan[] {
  const claimed: Array<readonly [number, number]> = [];
  const spans: RestorationSpan[] = [];
  const ordered = [...restorations].sort((a, b) => b.value.length - a.value.length);

  for (const restoration of ordered) {
    if (!restoration.value) continue;
    let from = 0;
    for (;;) {
      const index = visibleText.indexOf(restoration.value, from);
      if (index === -1) break;
      const end = index + restoration.value.length;
      if (!overlapsClaimed(claimed, index, end)) {
        spans.push({ start: index, end, restoration });
        claimed.push([index, end]);
      }
      from = end;
    }
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function overlapsClaimed(claimed: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
  return claimed.some(([s, e]) => s < end && e > start);
}

/** Whether any restoration's value is present in `visibleText` — the predicate that gates highlight
 * rendering and the surrogate toggle's availability. */
export function hasVisibleRestorations(visibleText: string, restorations: readonly RestoreHighlight[]): boolean {
  return restorations.some((restoration) => restoration.value.length > 0 && visibleText.includes(restoration.value));
}

export interface MarkdownCodeRegion {
  start: number;
  end: number;
}

const BLOCKQUOTE_PREFIX = /^(?: {0,3}> ?)+/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE_START = /^(?: {4,}|\t)\S/;
const INDENTED_CODE_CONTINUE = /^(?: {4,}|\t)/;
const BLANK_LINE = /^[ \t]*$/;

/**
 * Conservative scan of the markdown code regions in `text`: fenced blocks (``` / ~~~, including inside
 * blockquotes), indented code blocks, and inline backtick spans. Markdown renders code verbatim, so any
 * custom tag injected into these regions would surface as literal text; the highlight renderer uses this
 * to skip tag injection there.
 *
 * Unterminated constructs extend to end-of-text (fences) or end-of-paragraph (backtick runs), mirroring
 * how Streamdown's remend repairs incomplete markdown mid-stream — so a render during streaming never
 * injects tags into a region the finished text will treat as code. Every ambiguity is resolved toward
 * "code": a false positive merely loses a highlight, while a false negative corrupts visible text.
 *
 * Known conservative misses (all fail toward a lost highlight, never corruption): backslash-escaped
 * backticks in prose, list content indented ≥4 spaces after a blank line, and indented code inside
 * blockquotes (treated as prose). List-nested fences without a preceding blank line are matched by the
 * normal fence rules only up to 3 spaces of indentation.
 */
export function markdownCodeRegions(text: string): MarkdownCodeRegion[] {
  const regions: MarkdownCodeRegion[] = [];
  let openFence: { char: string; len: number; start: number } | null = null;
  let indented: { start: number; end: number } | null = null;
  let prevBlank = true;

  const flushIndented = () => {
    if (indented) {
      regions.push({ start: indented.start, end: indented.end });
      indented = null;
    }
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const stripped = line.replace(BLOCKQUOTE_PREFIX, "");
    const blank = BLANK_LINE.test(line);

    if (openFence) {
      const closeRun = stripped.match(FENCE_CLOSE)?.[1];
      if (closeRun?.startsWith(openFence.char) && closeRun.length >= openFence.len) {
        regions.push({ start: openFence.start, end: lineEnd });
        openFence = null;
      }
    } else {
      const open = stripped.match(FENCE_OPEN);
      const openRun = open?.[1];
      const infoString = open?.[2] ?? "";
      if (openRun && !(openRun.startsWith("`") && infoString.includes("`"))) {
        flushIndented();
        openFence = { char: openRun.charAt(0), len: openRun.length, start: lineStart };
      } else if (indented) {
        if (INDENTED_CODE_CONTINUE.test(line) && !blank) indented.end = lineEnd;
        else if (!blank) flushIndented();
      } else if (prevBlank && INDENTED_CODE_START.test(line)) {
        indented = { start: lineStart, end: lineEnd };
      }
    }

    prevBlank = blank;
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  const unterminatedFence: { start: number } | null = openFence;
  if (unterminatedFence) regions.push({ start: unterminatedFence.start, end: text.length });
  flushIndented();

  // Pass 2: inline backtick spans over the text not already claimed as a code block, scanned per
  // paragraph (a code span cannot cross a blank line). A run of N backticks is closed by the next run of
  // exactly N; with no closer, the rest of the paragraph is conservatively treated as code.
  const blockRegions = [...regions];
  let gapStart = 0;
  for (const region of [...blockRegions, { start: text.length, end: text.length }]) {
    if (region.start > gapStart) scanInlineCodeSpans(text, gapStart, region.start, regions);
    gapStart = Math.max(gapStart, region.end);
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

function scanInlineCodeSpans(text: string, from: number, to: number, regions: MarkdownCodeRegion[]): void {
  const gap = text.slice(from, to);
  const paragraphBreak = /\n[ \t]*\n/g;
  let chunkStart = 0;
  for (;;) {
    const separator = paragraphBreak.exec(gap);
    const chunkEnd = separator ? separator.index : gap.length;
    scanInlineCodeChunk(gap.slice(chunkStart, chunkEnd), from + chunkStart, regions);
    if (!separator) return;
    chunkStart = separator.index + separator[0].length;
  }
}

function scanInlineCodeChunk(chunk: string, offset: number, regions: MarkdownCodeRegion[]): void {
  const runs = [...chunk.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; ) {
    const open = runs[i];
    if (!open) return;
    const openStart = offset + open.index;
    let closeIndex = -1;
    for (let j = i + 1; j < runs.length; j += 1) {
      if (runs[j]?.[0].length === open[0].length) {
        closeIndex = j;
        break;
      }
    }
    const close = closeIndex === -1 ? undefined : runs[closeIndex];
    if (!close) {
      regions.push({ start: openStart, end: offset + chunk.length });
      return;
    }
    regions.push({ start: openStart, end: offset + close.index + close[0].length });
    i = closeIndex + 1;
  }
}

/**
 * Render `visibleText` to markdown with each located restoration wrapped in an origin-specific custom tag
 * (value in `values` mode, surrogate in `surrogates` mode). This is the ONLY place the tag/sentinel
 * format exists, derived per render from the structured sidecar — never stored. Returns `highlighted:
 * false` (and the raw text) when no restoration is present so callers can skip the custom-tag plumbing.
 */
export function renderVisibleHighlights(
  visibleText: string,
  restorations: readonly RestoreHighlight[],
  displayMode: RestoreHighlightDisplayMode = "values",
): { html: string; highlighted: boolean } {
  return renderProtectionHighlights(visibleText, restorationsToAnnotations(visibleText, restorations), displayMode);
}

/**
 * Render validated durable annotations as safe custom tags for Streamdown. Spans intersecting a markdown
 * code region get no tag — code renders verbatim, so a tag there would surface as literal text; the plain
 * value (or bare surrogate in `surrogates` mode, unescaped for the same reason) is emitted instead and
 * only the highlight is lost. Known limitation: a value inside a link destination/title still gets a tag,
 * which breaks the link's parse but renders as a mark rather than literal tag text.
 */
export function renderProtectionHighlights(
  visibleText: string,
  annotations: readonly ProtectionHighlightAnnotation[],
  displayMode: RestoreHighlightDisplayMode = "values",
): { html: string; highlighted: boolean } {
  const spans = normalizeProtectionAnnotations(visibleText, annotations);
  if (spans.length === 0) return { html: visibleText, highlighted: false };

  const codeRegions = markdownCodeRegions(visibleText);
  // Spans and regions are both sorted by start and non-overlapping, so a single advancing cursor
  // suffices: a region ending at or before this span's start can never intersect a later span either.
  let regionIndex = 0;
  const intersectsCode = (start: number, end: number): boolean => {
    while (regionIndex < codeRegions.length && (codeRegions[regionIndex]?.end ?? 0) <= start) regionIndex += 1;
    const region = codeRegions[regionIndex];
    return region !== undefined && region.start < end;
  };

  let out = "";
  let cursor = 0;
  let injected = false;
  for (const annotation of spans) {
    const { start, end, surrogate, origin, direction } = annotation;
    out += visibleText.slice(cursor, start);
    const visible = displayMode === "surrogates" ? surrogate : visibleText.slice(start, end);
    if (intersectsCode(start, end)) {
      out += visible;
    } else {
      const tag = protectionHighlightTag(direction, origin);
      out += `<${tag}>${escapeHtml(visible)}</${tag}>`;
      injected = true;
    }
    cursor = end;
  }
  out += visibleText.slice(cursor);
  return { html: out, highlighted: injected };
}

export function stripRestoreHighlightMarkers<T>(value: T): T {
  // Markers only exist when the proxy runs in trace-audit mode; on normal traffic there are none.
  // Scan first (read-only, allocates nothing) and return the original graph untouched when clean,
  // so the common case skips the deep clone + per-string rewrite this used to do on every call.
  if (!containsRestoreHighlightMarkersDeep(value)) return value;
  return cloneWithoutRestoreHighlightMarkers(value);
}

/**
 * Browser messages carry Ficta's durable UI metadata over the TanStack wire. This is the mandatory
 * model boundary: remove that namespace (and any in-band restore markers) before `chat()` conversion.
 */
export function stripProtectionDisplayMetadata<T>(value: T): T {
  const markerFree = stripRestoreHighlightMarkers(value);
  if (!containsProtectionMetadataDeep(markerFree)) return markerFree;
  return cloneWithoutProtectionMetadata(markerFree);
}

function containsProtectionMetadataDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProtectionMetadataDeep);
  const record = asRecord(value);
  if (!record) return false;
  const metadata = asRecord(record.metadata);
  if (metadata && FICTA_PROTECTION_METADATA_KEY in metadata) return true;
  return Object.values(record).some(containsProtectionMetadataDeep);
}

function cloneWithoutProtectionMetadata<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneWithoutProtectionMetadata(entry)) as T;
  const record = asRecord(value);
  if (!record) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "metadata") {
      const metadata = asRecord(entry);
      if (metadata && FICTA_PROTECTION_METADATA_KEY in metadata) {
        const cleanMetadata = { ...metadata };
        delete cleanMetadata[FICTA_PROTECTION_METADATA_KEY];
        if (Object.keys(cleanMetadata).length > 0) out.metadata = cloneWithoutProtectionMetadata(cleanMetadata);
        continue;
      }
    }
    out[key] = cloneWithoutProtectionMetadata(entry);
  }
  return out as T;
}

function containsRestoreHighlightMarkersDeep(value: unknown): boolean {
  if (typeof value === "string") return hasRestoreHighlightMarkers(value);
  if (Array.isArray(value)) return value.some(containsRestoreHighlightMarkersDeep);
  if (!value || typeof value !== "object") return false;
  for (const entry of Object.values(value)) if (containsRestoreHighlightMarkersDeep(entry)) return true;
  return false;
}

function cloneWithoutRestoreHighlightMarkers<T>(value: T): T {
  if (typeof value === "string") {
    return stripRestoreHighlightMarkersFromString(value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => cloneWithoutRestoreHighlightMarkers(entry)) as T;
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cloneWithoutRestoreHighlightMarkers(entry);
  return out as T;
}

function stripOrphanEndMarkers(content: string): string {
  return content.replaceAll(FICTA_RESTORE_HIGHLIGHT_END, "");
}

function stripRestoreHighlightMarkersFromString(content: string): string {
  return parseRestoreHighlightText(content).visibleText;
}

interface ParsedHighlightPayload {
  value: string;
  surrogate?: string;
  origin?: ProtectionPreviewOrigin;
}

function parseHighlightPayload(payload: string): ParsedHighlightPayload {
  const metadata = payload.indexOf(FICTA_RESTORE_HIGHLIGHT_METADATA);
  if (metadata <= 0) return { value: "" };
  const prefix = payload.slice(0, metadata);
  const originDelimiter = prefix.indexOf(FICTA_RESTORE_HIGHLIGHT_ORIGIN);
  if (originDelimiter <= 0) return { value: "" };
  const surrogate = prefix.slice(0, originDelimiter);
  const origin = prefix.slice(originDelimiter + FICTA_RESTORE_HIGHLIGHT_ORIGIN.length);
  if (!isSurrogateToken(surrogate) || !isProtectionOrigin(origin)) return { value: "" };
  return {
    surrogate,
    origin,
    value: stripTrailingMarkerPrefix(payload.slice(metadata + FICTA_RESTORE_HIGHLIGHT_METADATA.length)),
  };
}

function isSurrogateToken(value: string): boolean {
  return /^FICTA_(?:[0-9a-f]{32}|[A-Z0-9]{1,12}_[0-9a-f]{32}|(?:ORG|PERSON)_[A-Z2-7]{12}_[A-Z2-7]{12})$/.test(value);
}

function isProtectionOrigin(value: string | undefined): value is ProtectionPreviewOrigin {
  return value === "registry" || value === "detected" || value === "user";
}

function stripTrailingMarkerPrefix(content: string): string {
  let trim = 0;
  const markers = [
    FICTA_RESTORE_HIGHLIGHT_START,
    FICTA_RESTORE_HIGHLIGHT_ORIGIN,
    FICTA_RESTORE_HIGHLIGHT_METADATA,
    FICTA_RESTORE_HIGHLIGHT_END,
  ];
  // Every delimiter begins and ends with the same record-separator byte. A complete delimiter therefore
  // also looks like the one-byte prefix of every other delimiter; never trim when a full one is present.
  if (markers.some((marker) => content.endsWith(marker))) return content;
  for (const marker of markers) {
    for (let length = 1; length < marker.length; length += 1) {
      if (content.endsWith(marker.slice(0, length))) trim = Math.max(trim, length);
    }
  }
  return trim > 0 ? content.slice(0, -trim) : content;
}

function escapeHtml(content: string): string {
  return content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
