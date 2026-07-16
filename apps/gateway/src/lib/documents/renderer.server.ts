/**
 * Markdown → .docx render seam: the mirror image of converter.server.ts. The converter brings
 * documents *into* the redaction path (upload → markdown → proxy); this takes restored markdown the
 * browser already holds back *out* as a Word file. The render path never touches the model or the
 * proxy — that is a security property, not a shortcut: the proxy restores `FICTA_…` surrogates only
 * in text/JSON/SSE responses, so binary bytes emitted by the model would carry surrogates verbatim
 * into a client deliverable. Rendering server-side from already-restored text sidesteps that
 * entirely (the /api/render route additionally refuses text that still contains surrogates).
 *
 * Same out-of-process REST sidecar as conversion (one uniform contract, see
 * sidecars/document-converter/):
 *   - POST {url}/render   JSON { markdown, filename? }  →  200 .docx bytes
 *
 * Server-only: imported from the /api/render route. Markdown and the rendered bytes are handled
 * in-memory and never persisted here.
 */

import { converterConfig } from "./converter.server";

export interface RenderInput {
  markdown: string;
  /** Untrusted suggestion, forwarded for the sidecar's own Content-Disposition; the route sets the
   *  authoritative sanitized name on its response. */
  filename?: string;
}

export interface RenderResult {
  /** Pinned to `ArrayBuffer` (not the generic `ArrayBufferLike`) so it is a valid `BodyInit`. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** The render boundary. One REST implementation today; a future in-process JS renderer would be a
 *  second implementation behind this same interface. */
export interface DocumentRenderer {
  toDocx(input: RenderInput): Promise<RenderResult>;
}

export type RendererFailureReason = "unreachable" | "timeout" | "http_error" | "bad_response";

/** Typed backend failure. `detail` is safe metadata (status code, host, budget) — never document text. */
export class DocumentRendererUnavailableError extends Error {
  constructor(
    readonly reason: RendererFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `document renderer ${reason}: ${detail}` : `document renderer ${reason}`);
    this.name = "DocumentRendererUnavailableError";
  }
}

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const restDocumentRenderer: DocumentRenderer = {
  async toDocx({ markdown, filename }) {
    // Same sidecar, so the same URL/timeout env vars as conversion apply.
    const config = converterConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${config.url}/render`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markdown, filename }),
          signal: controller.signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw new DocumentRendererUnavailableError("timeout", `${config.timeoutMs}ms`);
        throw new DocumentRendererUnavailableError("unreachable", safeHost(config.url));
      }
      if (!res.ok) throw new DocumentRendererUnavailableError("http_error", String(res.status));
      if (!(res.headers.get("content-type") ?? "").startsWith(DOCX_CONTENT_TYPE)) {
        throw new DocumentRendererUnavailableError("bad_response", "not a docx response");
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) throw new DocumentRendererUnavailableError("bad_response", "empty body");
      return { bytes };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** The active renderer. A single REST backend today; branch here when a JS-native renderer lands. */
export function getRenderer(): DocumentRenderer {
  return restDocumentRenderer;
}

// --- helpers ---------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: unknown }).name === "AbortError" || (err as { name?: unknown }).name === "TimeoutError")
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
