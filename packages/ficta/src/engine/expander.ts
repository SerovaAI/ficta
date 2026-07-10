import type { Entity, Occurrence } from "./occurrence.js";

export interface ExpansionOptions {
  caseInsensitive?: boolean;
  wordBounded?: boolean;
}

export interface ExpansionSpan {
  /** Inclusive UTF-16 offset in `text`. */
  start: number;
  /** Exclusive UTF-16 offset in `text`. */
  end: number;
  /** Exact `text.slice(start, end)` surface. */
  surface: string;
}

/**
 * Find every non-overlapping surface matching `value` under the vault's whitespace-flexible rules.
 * Ranges are UTF-16 offsets and surfaces always re-anchor exactly to the input text.
 */
export function expansionSpans(text: string, value: string, opts: ExpansionOptions = {}): ExpansionSpan[] {
  if (!text || !value) return [];
  const re = new RegExp(flexiblePatternSource(value), opts.caseInsensitive ? "gi" : "g");
  const spans: ExpansionSpan[] = [];
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const surface = match[0];
    const start = match.index;
    const end = start + surface.length;
    if (surface && (!opts.wordBounded || hasTokenBoundaries(text, start, end, value))) {
      spans.push({ start, end, surface });
    }
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return spans;
}

/**
 * Expand logical entities into exact leaf-local occurrence claims. Registry values case-expand only
 * when word/name-like; detected entities retain today's case expansion with the lowercase-single-word
 * false-positive guard.
 */
export function expandEntities(leaves: readonly string[], entities: readonly Entity[]): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const forms = [...new Set([entity.canonical, ...entity.forms].filter(Boolean))];
    for (const form of forms) {
      if (entity.authority === "registry" && !isCaseExpandable(form)) continue;
      for (let leaf = 0; leaf < leaves.length; leaf++) {
        const text = leaves[leaf];
        if (text === undefined) continue;
        for (const span of expansionSpans(text, form, { caseInsensitive: true, wordBounded: true })) {
          if (entity.authority === "detected" && isLowercaseSingleWord(span.surface) && !isLowercaseSingleWord(form)) {
            continue;
          }
          const key = `${entity.id}\0${leaf}\0${span.start}\0${span.end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          occurrences.push({ leaf, ...span, origin: "expansion", entity });
        }
      }
    }
  }
  return occurrences;
}

/** Word/name-like registry values may safely gain case variants; opaque digit-bearing values may not. */
export function isCaseExpandable(value: string): boolean {
  if (/\d/.test(value)) return false;
  let letters = 0;
  for (const ch of value) {
    if (ch >= "a" && ch <= "z") letters++;
    else if (ch >= "A" && ch <= "Z") letters++;
    if (letters >= 2) return true;
  }
  return false;
}

export function isLowercaseSingleWord(value: string): boolean {
  const trimmed = value.trim();
  return !/\s/u.test(trimmed) && /\p{L}/u.test(trimmed) && trimmed === trimmed.toLowerCase();
}

/** Shared pattern source used by both expansion and the existing vault matcher. */
export function flexiblePatternSource(value: string): string {
  // Each separator permits at most one line break. This covers ordinary document reflow without
  // bridging a blank line/paragraph break or matching a value whose separator disappeared entirely.
  return value
    .split(/(\s+)/)
    .map((part) =>
      hasWhitespace(part) ? "(?:[^\\S\\r\\n]+|[^\\S\\r\\n]*(?:\\r\\n|\\r|\\n)[^\\S\\r\\n]*)" : escapeRegExp(part),
    )
    .join("");
}

/** Reject a word-like match embedded in a larger Unicode word, while leaving punctuation edges alone. */
function hasTokenBoundaries(text: string, start: number, end: number, value: string): boolean {
  const first = codePointAfter(value, 0);
  const last = codePointBefore(value, value.length);
  if (isWordCodePoint(first) && isWordCodePoint(codePointBefore(text, start))) return false;
  if (isWordCodePoint(last) && isWordCodePoint(codePointAfter(text, end))) return false;
  return true;
}

function isWordCodePoint(value: string): boolean {
  return value !== "" && /[\p{L}\p{M}\p{N}_]/u.test(value);
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  const high = index > 1 ? text.charCodeAt(index - 2) : 0;
  const paired = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(paired ? index - 2 : index - 1, index);
}

function codePointAfter(text: string, index: number): string {
  if (index >= text.length) return "";
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
