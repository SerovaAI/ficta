import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";

export const RESTORE_HIGHLIGHT_TAG = "ficta-restore";

export type RestoreHighlightDisplayMode = "values" | "surrogates";

/** One restored PII span the proxy highlighted: its real `value` and (optionally) the `surrogate` the
 * model actually saw. This is the structured, in-memory display metadata — the delimiter markers it is
 * parsed from never live past {@link parseRestoreHighlightText}. */
export interface RestoreHighlight {
  value: string;
  surrogate?: string;
}

/** The result of parsing marker-bearing streamed text into display metadata: the clean text to show and
 * the restorations to highlight within it. Only `visibleText` is ever persisted; `restorations` stay
 * memory-only (see `use-restore-highlight-display.ts`). */
export interface ParsedRestoreText {
  visibleText: string;
  restorations: RestoreHighlight[];
}

/** A message part carrying parsed restore-highlight metadata for display. Rides on the derived display
 * transcript only — never on `messages`, storage, or replay. */
export interface RestoreHighlightPart {
  restorations?: RestoreHighlight[];
}

export function hasRestoreHighlightMarkers(content: string): boolean {
  return content.includes(FICTA_RESTORE_HIGHLIGHT_START) || content.includes(FICTA_RESTORE_HIGHLIGHT_END);
}

/**
 * Parse marker-bearing streamed assistant text into a structured sidecar: the clean `visibleText` (real
 * values substituted, markers removed — identical to what {@link stripRestoreHighlightMarkers} produces)
 * plus the ordered, de-duplicated list of `{ value, surrogate }` restorations. This is the single client
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
    const parsed = parseHighlightPayload(payload, end !== -1);
    visibleText += parsed.value;

    // Only complete markers (END seen) with a non-empty value are real restorations; a partial marker at
    // the stream tail is left for the next chunk. De-dupe by value so a value repeated in one turn is
    // located once and highlighted at every occurrence at render time.
    if (end !== -1 && parsed.value && !seen.has(parsed.value)) {
      seen.add(parsed.value);
      restorations.push({ value: parsed.value, surrogate: parsed.surrogate });
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

/**
 * Render `visibleText` to markdown with each located restoration wrapped in a `<ficta-restore>` tag
 * (value in `values` mode, surrogate in `surrogates` mode). This is the ONLY place the tag/sentinel
 * format exists, derived per render from the structured sidecar — never stored. Returns `highlighted:
 * false` (and the raw text) when no restoration is present so callers can skip the custom-tag plumbing.
 */
export function renderVisibleHighlights(
  visibleText: string,
  restorations: readonly RestoreHighlight[],
  displayMode: RestoreHighlightDisplayMode = "values",
): { html: string; highlighted: boolean } {
  const spans = locateRestorationSpans(visibleText, restorations);
  if (spans.length === 0) return { html: visibleText, highlighted: false };

  let out = "";
  let cursor = 0;
  for (const { start, end, restoration } of spans) {
    out += visibleText.slice(cursor, start);
    const visible = displayMode === "surrogates" && restoration.surrogate ? restoration.surrogate : restoration.value;
    out += `<${RESTORE_HIGHLIGHT_TAG}>${escapeHtml(visible)}</${RESTORE_HIGHLIGHT_TAG}>`;
    cursor = end;
  }
  out += visibleText.slice(cursor);
  return { html: out, highlighted: true };
}

export function stripRestoreHighlightMarkers<T>(value: T): T {
  // Markers only exist when the proxy runs in trace-audit mode; on normal traffic there are none.
  // Scan first (read-only, allocates nothing) and return the original graph untouched when clean,
  // so the common case skips the deep clone + per-string rewrite this used to do on every call.
  if (!containsRestoreHighlightMarkersDeep(value)) return value;
  return cloneWithoutRestoreHighlightMarkers(value);
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

function parseHighlightPayload(payload: string, complete: boolean): { value: string; surrogate?: string } {
  const metadata = payload.indexOf(FICTA_RESTORE_HIGHLIGHT_METADATA);
  if (metadata > 0) {
    const maybeSurrogate = payload.slice(0, metadata);
    if (isSurrogateToken(maybeSurrogate)) {
      return {
        surrogate: maybeSurrogate,
        value: stripTrailingMarkerPrefix(payload.slice(metadata + FICTA_RESTORE_HIGHLIGHT_METADATA.length)),
      };
    }
  }

  // During streaming, a new-format marker can arrive as START + partial surrogate before the metadata
  // separator. Hide that incomplete metadata so the UI never flashes marker internals.
  if (!complete && isPotentialSurrogateMetadataPrefix(payload)) return { value: "" };

  return { value: stripTrailingMarkerPrefix(payload) };
}

function isSurrogateToken(value: string): boolean {
  return /^FICTA_(?:[0-9a-f]{32}|[A-Z0-9]{1,12}_[0-9a-f]{32})$/.test(value);
}

function isPotentialSurrogateMetadataPrefix(value: string): boolean {
  return /^FICTA_[A-Z0-9a-f_]*$/.test(value) || "FICTA_".startsWith(value);
}

function stripTrailingMarkerPrefix(content: string): string {
  let trim = 0;
  for (const marker of [FICTA_RESTORE_HIGHLIGHT_START, FICTA_RESTORE_HIGHLIGHT_METADATA, FICTA_RESTORE_HIGHLIGHT_END]) {
    for (let length = 1; length < marker.length; length += 1) {
      if (content.endsWith(marker.slice(0, length))) trim = Math.max(trim, length);
    }
  }
  return trim > 0 ? content.slice(0, -trim) : content;
}

function escapeHtml(content: string): string {
  return content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
