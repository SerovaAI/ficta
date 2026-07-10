/**
 * Mask Markdown *formatting* so an NLP/NER backend sees cleaner prose. A `.docx`/`.pdf` converted by
 * markitdown (or similar) wraps entities in `**bold**`, escapes punctuation as `\_`, and adds `### `
 * headings, `- ` lists, `~~strike~~`, and `` `code` `` — none of which is content, but all of which
 * contaminate NER spans (`THE GRAM FOUNDATION**`, `Offers of Sale:** All Shares`) and depress recall (a
 * party name in an ALL-CAPS `**heading**` gets missed or mis-bounded, then leaks). Only the NLP backends
 * run on the normalized text; regex recognizers keep the raw text (see `pii/index.ts`).
 *
 * Design constraints:
 * - EQUAL-LENGTH masking — every stripped syntax char becomes a space, so character offsets are
 *   unchanged. Presidio maps code-point offsets back to text slices; keeping length 1:1 keeps them valid.
 * - CONSERVATIVE — mask only unambiguous formatting. Content punctuation that appears inside real
 *   entities is left intact: parentheses (`LSD Open (Pty) Ltd`), hyphens, colons, `|`, and bare `_`
 *   (identifiers / `snake_case`). Only `*`, `~`, backtick, backslash escapes, and line-leading
 *   heading/list markers are touched.
 * - The masked value stays a substring of the ORIGINAL for whole-token wrapping (`**NAME**` → `  NAME  `,
 *   the `**` sit outside the name), so value-based redaction on the original text still finds it after a
 *   trim. Markdown *inside* a multi-word entity (`LSD **Open** FZCO`) is a known gap — the normalized
 *   value is no longer a contiguous substring of the raw text — but whole-token wrapping is the norm.
 */
export function normalizeMarkdownForDetection(text: string): string {
  if (!text) return text;
  let out = text;

  // Backslash escapes (markitdown escapes markdown-special punctuation, e.g. \_ \* \.): drop the
  // backslash to a space, keep the escaped char. Length-preserving (`\X` → ` X`).
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, " $1");

  // Emphasis / strikethrough / inline-code runs anywhere (`*`, `**`, `***`, `~~`, `` ` ``) → spaces.
  out = out.replace(/[*~`]+/g, (run) => " ".repeat(run.length));

  // Line-leading ATX heading markers ("# " … "###### "): mask the hashes, keep the trailing space.
  out = out.replace(
    /^([ \t]*)(#{1,6})(?=[ \t])/gm,
    (_m, lead: string, hashes: string) => lead + " ".repeat(hashes.length),
  );

  // Line-leading unordered list markers ("- ", "+ "): mask the single bullet char ("*" bullets are
  // already covered by the emphasis run above).
  out = out.replace(/^([ \t]*)[-+](?=[ \t])/gm, (_m, lead: string) => `${lead} `);

  // Line-leading ordered list markers ("1. ", "23. "): mask the digits + dot, keep the trailing space.
  out = out.replace(
    /^([ \t]*)(\d+)\.(?=[ \t])/gm,
    (_m, lead: string, digits: string) => `${lead}${" ".repeat(digits.length)} `,
  );

  return out;
}
