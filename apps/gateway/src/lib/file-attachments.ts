export interface TextAttachment {
  id: string;
  name: string;
  size: number;
  content: string;
}

export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
/** Binary documents (PDF/DOCX) are far larger than text and are sent to the converter sidecar, not
 *  inlined raw, so they get their own — larger — cap. Enforced client-side and again in /api/extract. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Formats the browser can't read as text; they go through /api/extract to become Markdown first. */
const EXTRACTABLE_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const EXTRACTABLE_DOCUMENT_MIME_PARTS = ["pdf", "msword", "wordprocessingml"];

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".lua",
  ".markdown",
  ".md",
  ".mjs",
  ".ndjson",
  ".php",
  ".pl",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/xml",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

export const ATTACHMENT_ACCEPT = [
  ...TEXT_EXTENSIONS,
  ".dockerfile",
  ".gitignore",
  ".pdf",
  ".doc",
  ".docx",
  "text/*",
  ...TEXT_MIME_TYPES,
].join(",");

/** A PDF/DOC/DOCX that must be converted to Markdown (via /api/extract) before it can be attached. */
export function needsExtraction(file: File): boolean {
  const ext = extensionOf(file.name);
  const mime = file.type.toLowerCase();
  return (
    EXTRACTABLE_DOCUMENT_EXTENSIONS.has(ext) || EXTRACTABLE_DOCUMENT_MIME_PARTS.some((part) => mime.includes(part))
  );
}

export function isSupportedTextFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const ext = extensionOf(name);
  const mime = file.type.toLowerCase();
  return (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    TEXT_EXTENSIONS.has(ext) ||
    name === "dockerfile" ||
    name === "makefile" ||
    name === ".gitignore" ||
    name.startsWith(".env")
  );
}

export async function textAttachmentFromFile(file: File): Promise<TextAttachment> {
  return {
    id: attachmentId(file),
    name: file.name || "attachment.txt",
    size: file.size,
    content: await file.text(),
  };
}

/**
 * Sends a document to /api/extract and returns its Markdown as a text attachment. Throws with a
 * user-facing message on any failure so the caller can surface it as an upload warning (the document is
 * simply not attached — never silently sent un-extracted). The chip's `size` reflects the extracted
 * Markdown, since that (not the original binary) is what gets inlined and redacted.
 */
export async function extractDocumentAttachment(file: File): Promise<TextAttachment> {
  const form = new FormData();
  form.append("file", file, file.name);

  let res: Response;
  try {
    res = await fetch("/api/extract", { method: "POST", body: form });
  } catch {
    throw new Error(`${file.name || "That document"} could not be uploaded for extraction.`);
  }

  if (!res.ok) {
    throw new Error((await errorMessage(res)) ?? `${file.name || "That document"} could not be extracted.`);
  }

  const data = (await res.json().catch(() => null)) as { markdown?: unknown; name?: unknown } | null;
  const markdown = typeof data?.markdown === "string" ? data.markdown : "";
  if (!markdown.trim()) throw new Error(`No text could be extracted from ${file.name || "that document"}.`);

  return {
    id: attachmentId(file),
    name: file.name || "document",
    size: new TextEncoder().encode(markdown).length,
    content: markdown,
  };
}

async function errorMessage(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : undefined;
  } catch {
    return undefined;
  }
}

function attachmentId(file: File): string {
  return `${file.name || "attachment"}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}
