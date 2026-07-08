import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";

export const RESTORE_HIGHLIGHT_TAG = "ficta-restore";

export type RestoreHighlightDisplayMode = "values" | "surrogates";

export function hasRestoreHighlightMarkers(content: string): boolean {
  return content.includes(FICTA_RESTORE_HIGHLIGHT_START) || content.includes(FICTA_RESTORE_HIGHLIGHT_END);
}

export function restoreHighlightsToHtml(content: string, displayMode: RestoreHighlightDisplayMode = "values"): string {
  let out = "";
  let cursor = 0;

  for (;;) {
    const start = content.indexOf(FICTA_RESTORE_HIGHLIGHT_START, cursor);
    if (start === -1) {
      out += stripTrailingMarkerPrefix(stripOrphanEndMarkers(content.slice(cursor)));
      return out;
    }

    out += stripOrphanEndMarkers(content.slice(cursor, start));
    const valueStart = start + FICTA_RESTORE_HIGHLIGHT_START.length;
    const end = content.indexOf(FICTA_RESTORE_HIGHLIGHT_END, valueStart);
    const payload = end === -1 ? stripTrailingMarkerPrefix(content.slice(valueStart)) : content.slice(valueStart, end);
    const highlighted = parseHighlightPayload(payload, end !== -1);
    const visible = displayMode === "surrogates" && highlighted.surrogate ? highlighted.surrogate : highlighted.value;
    out += `<${RESTORE_HIGHLIGHT_TAG}>${escapeHtml(visible)}</${RESTORE_HIGHLIGHT_TAG}>`;

    if (end === -1) return out;
    cursor = end + FICTA_RESTORE_HIGHLIGHT_END.length;
  }
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
  let out = "";
  let cursor = 0;

  for (;;) {
    const start = content.indexOf(FICTA_RESTORE_HIGHLIGHT_START, cursor);
    if (start === -1) {
      out += stripTrailingMarkerPrefix(stripOrphanEndMarkers(content.slice(cursor)));
      return out;
    }

    out += stripOrphanEndMarkers(content.slice(cursor, start));
    const valueStart = start + FICTA_RESTORE_HIGHLIGHT_START.length;
    const end = content.indexOf(FICTA_RESTORE_HIGHLIGHT_END, valueStart);
    const payload = end === -1 ? stripTrailingMarkerPrefix(content.slice(valueStart)) : content.slice(valueStart, end);
    out += parseHighlightPayload(payload, end !== -1).value;

    if (end === -1) return out;
    cursor = end + FICTA_RESTORE_HIGHLIGHT_END.length;
  }
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
