/**
 * The document kinds /api/extract hands to the converter, decided from the bytes. The filename and MIME
 * type are client-chosen, and the converter dispatches on content as well as the name, so a name check
 * alone would let any format through (audio, spreadsheets, archives) to whatever parser recognises it.
 */
export type ExtractableKind = "pdf" | "docx";

export const EXTRACTABLE_KIND_EXTENSION: Record<ExtractableKind, string> = { pdf: ".pdf", docx: ".docx" };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04", a DOCX container
/** PDF readers accept the header anywhere in the first 1 KiB, after leading junk. */
const PDF_HEADER_WINDOW = 1024;

export function sniffExtractableDocument(bytes: Uint8Array): ExtractableKind | undefined {
  if (indexOf(bytes.subarray(0, PDF_HEADER_WINDOW), PDF_MAGIC) !== -1) return "pdf";
  // Only the container is checked here; the sidecar confirms it holds word/document.xml and bounds its
  // uncompressed size before parsing.
  if (indexOf(bytes.subarray(0, ZIP_MAGIC.length), ZIP_MAGIC) === 0) return "docx";
  return undefined;
}

/** `name` with its extension replaced by the sniffed kind's, so the converter's name hint matches the bytes. */
export function withKindExtension(name: string, kind: ExtractableKind): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name) || "document";
  return `${stem}${EXTRACTABLE_KIND_EXTENSION[kind]}`;
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
