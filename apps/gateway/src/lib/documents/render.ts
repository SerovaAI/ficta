/**
 * Pure, client-safe pieces of the Markdown → .docx download path, shared between the /api/render
 * route and the browser-side download hook (pre-checks without a round trip). Server-only transport
 * lives in renderer.server.ts.
 */

/** Upper bound for one render request's markdown, enforced with 413 by /api/render. Far above any
 *  real contract (a 100-page agreement is ~300 KB of markdown) but bounds sidecar work. */
export const MAX_RENDER_MARKDOWN_BYTES = 2 * 1024 * 1024;

/**
 * Reduce an untrusted filename (model-suggested titles reach this) to a header-safe basename with a
 * forced `.docx` extension. Mirrors `_safe_docx_filename` in the sidecar — the route's value is the
 * one that reaches the browser's Content-Disposition, so it sanitizes independently.
 */
export function safeDocxFilename(name: string | null | undefined): string {
  const base = (name ?? "").trim().replace(/\\/g, "/").split("/").pop() ?? "";
  let stem = base.replace(/\.docx$/i, "");
  stem = stem.replace(/[^\w. ()-]+/g, "_").replace(/^[. ]+|[. ]+$/g, "") || "document";
  return `${stem}.docx`;
}
