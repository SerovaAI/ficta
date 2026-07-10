export type MarkdownOffsetEdge = "start" | "end";

export interface MarkdownDetectionView {
  /** Markdown-clean text sent to an NLP backend. */
  text: string;
  /** Map a normalized UTF-16 boundary back to a raw UTF-16 boundary. */
  toRaw(offset: number, edge?: MarkdownOffsetEdge): number | undefined;
}

/**
 * Remove unambiguous Markdown syntax for NLP while retaining an exact normalized→raw boundary map.
 * The compact view closes internal-formatting gaps (`LSD **Open** FZCO` → `LSD Open FZCO`).
 */
export function normalizeMarkdownForDetection(text: string): MarkdownDetectionView {
  if (!text) return identityView(text);

  const removed = new Uint8Array(text.length);
  const remove = (start: number, end: number): void => {
    for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) removed[i] = 1;
  };

  // Backslash escapes keep the escaped content byte and remove only the formatting backslash.
  for (const match of text.matchAll(/\\([\\`*_{}[\]()#+\-.!|~>])/g)) remove(match.index, match.index + 1);
  // Emphasis, strike, and inline-code delimiters. Removing rather than masking lets words separated
  // only by internal formatting become contiguous in the detector view.
  for (const match of text.matchAll(/[*~`]+/g)) remove(match.index, match.index + match[0].length);
  // Line-leading headings and list markers; retain following whitespace/content.
  for (const match of text.matchAll(/^([ \t]*)(#{1,6})(?=[ \t])/gm)) {
    const lead = match[1]?.length ?? 0;
    remove(match.index + lead, match.index + lead + (match[2]?.length ?? 0));
  }
  for (const match of text.matchAll(/^([ \t]*)[-+](?=[ \t])/gm)) {
    remove(match.index + (match[1]?.length ?? 0), match.index + match[0].length);
  }
  for (const match of text.matchAll(/^([ \t]*)(\d+)\.(?=[ \t])/gm)) {
    const lead = match[1]?.length ?? 0;
    const markerLength = (match[2]?.length ?? 0) + 1;
    remove(match.index + lead, match.index + lead + markerLength);
  }

  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [firstKeptIndex(removed, 0, text.length)];
  for (let raw = 0; raw < text.length; raw++) {
    if (removed[raw]) continue;
    starts.push(raw);
    normalized += text[raw];
    ends.push(raw + 1);
  }
  starts.push(text.length);

  return {
    text: normalized,
    toRaw(offset, edge = "start") {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > normalized.length) return undefined;
      return edge === "end" ? ends[offset] : starts[offset];
    },
  };
}

function identityView(text: string): MarkdownDetectionView {
  return {
    text,
    toRaw(offset) {
      return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length ? offset : undefined;
    },
  };
}

function firstKeptIndex(removed: Uint8Array, start: number, fallback: number): number {
  for (let i = start; i < removed.length; i++) if (!removed[i]) return i;
  return fallback;
}
