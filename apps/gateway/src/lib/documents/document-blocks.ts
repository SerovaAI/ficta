/**
 * The `ficta:` fence protocol — how the model hands the gateway a document inside ordinary
 * assistant text. A generated contract arrives as:
 *
 *     ```ficta:document title="Consulting Agreement"
 *     ...full markdown contract...
 *     ```
 *
 * Fenced *text* (not tool-use) is deliberate: the proxy fully restores surrogates in assistant
 * text, while `restoreIntoTools=detected` (the default) withholds registry-layer secrets from
 * tool-call arguments — and registry secrets are exactly the party/matter names contracts are full
 * of. The parser dispatches on the fence info-string (`ficta:<type>`) so v2's `ficta:patch` slots
 * in without touching this file's callers.
 *
 * Pure string parsing, shared by the download hook, the document-card renderer, and the outbound
 * prompt instruction. No transport, no DOM.
 */

export const DOCUMENT_FENCE_TYPE = "document";

/** Appended to a user turn that carries an extracted document (see messageWithAttachments): rides
 *  the normal user-text redaction path, so it stays covered by the protection-review flow —
 *  deliberately not a server-side system prompt. */
export const DOCUMENT_FENCE_INSTRUCTION = [
  "When you produce or revise a document, output the complete document — every clause and section,",
  "no elisions or placeholders like “[unchanged]” — inside a single fenced block that starts with",
  '```ficta:document title="<document title>" and ends with ```. Use # / ## headings for articles',
  "and sections, numbered lists for clauses and sub-clauses, and bold for defined terms. Keep any",
  "commentary or explanation outside the fence.",
].join(" ");

/** One parsed `ficta:` fence. Offsets are UTF-16 indices into the source text, so callers can slice
 *  around the block and remap span annotations into it. */
export interface FictaBlock {
  /** The fence type after the `ficta:` prefix — "document" today, "patch" in v2. */
  type: string;
  /** `key="value"` pairs from the fence info string (e.g. title). Untrusted model output. */
  attrs: Record<string, string>;
  content: string;
  /** Start of the opening fence line. */
  start: number;
  /** End of the closing fence line, or end of text while unterminated. */
  end: number;
  contentStart: number;
  contentEnd: number;
  /** False while the closing fence has not streamed in yet. */
  closed: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*(.*)$/;
const ATTR = /(\w+)="([^"]*)"/g;

/** Parse every `ficta:` fence in the text, tolerating an unterminated final fence (mid-stream).
 *  Fences opened inside an ordinary code block are not ficta blocks and are skipped. */
export function parseFictaBlocks(text: string): FictaBlock[] {
  const blocks: FictaBlock[] = [];
  // Open fence state: a ficta block being collected, or an ordinary code fence being skipped.
  let open: { block?: FictaBlock; char: string; length: number } | undefined;

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);

    if (open) {
      if (isClosingFence(line, open.char, open.length)) {
        if (open.block) {
          open.block.contentEnd = Math.max(open.block.contentStart, lineStart - 1);
          open.block.content = text.slice(open.block.contentStart, open.block.contentEnd);
          open.block.end = lineEnd;
          open.block.closed = true;
          blocks.push(open.block);
        }
        open = undefined;
      }
    } else {
      const match = FENCE_OPEN.exec(line);
      if (match) {
        const [, fence, info, rest] = match as unknown as [string, string, string, string];
        if (info.startsWith("ficta:")) {
          const contentStart = newline === -1 ? text.length : newline + 1;
          open = {
            char: fence[0] as string,
            length: fence.length,
            block: {
              type: info.slice("ficta:".length),
              attrs: parseAttrs(rest),
              content: "",
              start: lineStart,
              end: text.length,
              contentStart,
              contentEnd: text.length,
              closed: false,
            },
          };
        } else {
          open = { char: fence[0] as string, length: fence.length };
        }
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  // Unterminated ficta fence: still a block (the card renders it while it streams).
  if (open?.block) {
    open.block.content = text.slice(open.block.contentStart);
    blocks.push(open.block);
  }
  return blocks;
}

/** The block the download and card act on: the last `ficta:document` fence in the message. */
export function lastDocumentBlock(text: string): FictaBlock | undefined {
  const blocks = parseFictaBlocks(text).filter((block) => block.type === DOCUMENT_FENCE_TYPE);
  return blocks[blocks.length - 1];
}

export interface DocumentDownloadSource {
  markdown: string;
  title?: string;
  /** True when an actual closed fence was found; false for the whole-message fallback (the button
   *  still works when the model ignored fencing — but auto-render never fires on the fallback). */
  fromFence: boolean;
}

/** What a "Download as Word" click renders. Last *closed* document fence; falls back to the whole
 *  message text so the button still works when the model ignored the fence convention. */
export function documentDownloadSource(text: string): DocumentDownloadSource | undefined {
  const block = lastDocumentBlock(text);
  if (block?.closed && block.content.trim()) {
    return { markdown: block.content, title: block.attrs.title?.trim() || undefined, fromFence: true };
  }
  if (!text.trim()) return undefined;
  return { markdown: text, fromFence: false };
}

/** Last markdown heading in (possibly partial) fence content — the card's streaming progress line. */
export function lastHeading(content: string): string | undefined {
  let heading: string | undefined;
  for (const line of content.split("\n")) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) heading = match[1];
  }
  return heading;
}

function isClosingFence(line: string, char: string, length: number): boolean {
  const trimmed = line.trimEnd();
  const indent = trimmed.length - trimmed.trimStart().length;
  if (indent > 3) return false;
  const body = trimmed.trimStart();
  return body.length >= length && [...body].every((c) => c === char);
}

function parseAttrs(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of rest.matchAll(ATTR)) {
    attrs[match[1] as string] = match[2] as string;
  }
  return attrs;
}
