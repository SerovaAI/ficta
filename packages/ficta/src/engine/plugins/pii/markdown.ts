export type MarkdownOffsetEdge = "start" | "end";

export interface MarkdownDetectionView {
  /** Markdown-clean text sent to an NLP backend. */
  text: string;
  /** Whether the compatibility equal-length masker produced this view. */
  equalLength: boolean;
  /** Map a normalized UTF-16 boundary back to a raw UTF-16 boundary. */
  toRaw(offset: number, edge?: MarkdownOffsetEdge): number | undefined;
}

/**
 * Remove unambiguous Markdown syntax for NLP while retaining an exact normalized→raw boundary map.
 * The default compact view closes internal-formatting gaps (`LSD **Open** FZCO` → `LSD Open FZCO`).
 * `equalLength` retains the previous space-mask algorithm as a one-release rollback path.
 */
export function normalizeMarkdownForDetection(
  text: string,
  opts: { equalLength?: boolean } = {},
): MarkdownDetectionView {
  if (opts.equalLength) return equalLengthView(text);
  if (!text) return identityView(text, false);

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
    equalLength: false,
    toRaw(offset, edge = "start") {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > normalized.length) return undefined;
      return edge === "end" ? ends[offset] : starts[offset];
    },
  };
}

function equalLengthView(text: string): MarkdownDetectionView {
  if (!text) return identityView(text, true);
  let out = text;
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, " $1");
  out = out.replace(/[*~`]+/g, (run) => " ".repeat(run.length));
  out = out.replace(
    /^([ \t]*)(#{1,6})(?=[ \t])/gm,
    (_match, lead: string, hashes: string) => lead + " ".repeat(hashes.length),
  );
  out = out.replace(/^([ \t]*)[-+](?=[ \t])/gm, (_match, lead: string) => `${lead} `);
  out = out.replace(
    /^([ \t]*)(\d+)\.(?=[ \t])/gm,
    (_match, lead: string, digits: string) => `${lead}${" ".repeat(digits.length)} `,
  );
  return identityView(out, true);
}

function identityView(text: string, equalLength: boolean): MarkdownDetectionView {
  return {
    text,
    equalLength,
    toRaw(offset) {
      return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length ? offset : undefined;
    },
  };
}

function firstKeptIndex(removed: Uint8Array, start: number, fallback: number): number {
  for (let i = start; i < removed.length; i++) if (!removed[i]) return i;
  return fallback;
}
