/** Tiny shared text helpers: CLI/banner/doctor formatting and token-safe truncation. */

import { residualSurrogatePattern } from "./surrogate.js";

export function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

/** A bracketed redaction marker such as `[REDACTED]` or `[REDACTED_CARD]`. */
const REDACTION_MARKER_SOURCE = String.raw`\[REDACTED(?:_[A-Z0-9]+)*\]`;

interface TruncateRedactedOptions {
  /**
   * Appended when the text is shortened (default `""`). It counts toward `maxLength`, so the result
   * is never longer than `maxLength`; when the suffix alone would not fit, it is dropped and the
   * whole budget goes to text. Text that already fits is returned unchanged, with no suffix.
   */
  ellipsis?: string;
  /**
   * Cut at the last whitespace before the limit instead of mid-word, and drop the trailing
   * whitespace. When the limit falls inside the first word there is no earlier boundary, so this
   * falls back to a character cut (still token-safe) rather than returning an empty string.
   */
  wordBoundary?: boolean;
}

/**
 * Shorten redacted text to at most `maxLength` UTF-16 code units without cutting a surrogate token
 * (every `FICTA_…` shape ficta emits: opaque hex, typed, and entity-family) or a bracketed
 * `[REDACTED…]` marker in half. A partially cut token can never be restored, so a token that
 * straddles the limit is dropped entirely and the cut moves to just before it. The cut also never
 * splits a UTF-16 surrogate pair (an emoji or other astral character); it does not segment
 * multi-code-point grapheme clusters such as ZWJ emoji sequences.
 *
 * The result (minus any `ellipsis`) is always a prefix of `text`.
 */
export function truncateRedactedText(text: string, maxLength: number, options: TruncateRedactedOptions = {}): string {
  const limit = Math.max(0, Math.floor(maxLength));
  if (text.length <= limit) return text;

  const ellipsis = options.ellipsis ?? "";
  const suffix = ellipsis.length <= limit ? ellipsis : "";
  let cut = limit - suffix.length;

  cut = cutOutsideAtoms(text, cut);
  if (options.wordBoundary && cut > 0 && !/\s/u.test(text[cut] ?? "")) {
    const boundary = lastWhitespaceBefore(text, cut);
    // A whitespace character is never inside a token or a surrogate pair, so this stays safe.
    if (boundary > 0) cut = boundary;
  }
  cut = notInsidePair(text, cut);

  let head = text.slice(0, cut);
  if (options.wordBoundary) head = head.trimEnd();
  return head + suffix;
}

/** Move `cut` back to the start of any surrogate token or redaction marker it would split. */
function cutOutsideAtoms(text: string, cut: number): number {
  const atoms = new RegExp(`${residualSurrogatePattern().source}|${REDACTION_MARKER_SOURCE}`, "g");
  for (const match of text.matchAll(atoms)) {
    const start = match.index;
    if (start >= cut) break;
    if (start + match[0].length > cut) return start;
  }
  return cut;
}

function lastWhitespaceBefore(text: string, cut: number): number {
  for (let i = cut - 1; i > 0; i--) if (/\s/u.test(text[i] ?? "")) return i;
  return -1;
}

function notInsidePair(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const before = text.charCodeAt(cut - 1);
  const after = text.charCodeAt(cut);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? cut - 1 : cut;
}
