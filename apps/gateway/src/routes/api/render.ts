import { createFileRoute } from "@tanstack/react-router";
import { scopeFromAuth } from "../../lib/auth/guards.server";
import { getActiveProvider } from "../../lib/auth/provider.server";
import { MAX_RENDER_MARKDOWN_BYTES, safeDocxFilename } from "../../lib/documents/render";
import { DocumentRendererUnavailableError, getRenderer } from "../../lib/documents/renderer.server";
import { stripRestoreHighlightMarkers } from "../../lib/restore-highlights";
import { validateRestoredText } from "../../lib/restore-validation";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Renders restored Markdown the browser already holds into a .docx via the document-converter
 * sidecar — the outbound mirror of /api/extract. Like extraction, this route does NOT talk to the
 * model or persist anything; the markdown and rendered bytes live only for the duration of the call.
 *
 * The placeholder gate is the one check with no /api/extract counterpart: a `FICTA_…` surrogate must
 * never ship inside a client deliverable, so text that still contains one (complete or truncated) is
 * refused with 422. This is deliberately more conservative than chat display, where a residual
 * surrogate is only counted as telemetry (restore-validation.ts). The download hook runs the same
 * check client-side first for an inline explanation; this server-side gate is the authority.
 */
export const Route = createFileRoute("/api/render")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Defense in depth: the UI is gated, but re-verify the session on the route that reaches the
        // sidecar. In `none` mode requiresAuth is false, so this is a no-op.
        const auth = await (await getActiveProvider()).getAuthState();
        const scope = scopeFromAuth(auth);
        if (auth.requiresAuth && !scope) return json(401, { error: "Sign in to download documents." });

        // Refuse an oversized declared body before buffering it. The post-parse markdown check
        // below stays authoritative (chunked requests carry no content-length); the slack covers
        // the JSON envelope and escaping overhead.
        const declaredBytes = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RENDER_MARKDOWN_BYTES * 2) {
          return json(413, { error: "That document is too large to render as Word." });
        }

        let markdown: string;
        let filename: string | undefined;
        try {
          const body: unknown = await request.json();
          if (!isRecord(body) || typeof body.markdown !== "string") {
            throw new Error('missing "markdown" field');
          }
          markdown = body.markdown;
          filename = typeof body.filename === "string" ? body.filename : undefined;
        } catch (err) {
          return json(400, { error: reason(err, "Malformed render request.") });
        }

        if (!markdown.trim()) return json(400, { error: "There is no document text to render." });
        if (byteLength(markdown) > MAX_RENDER_MARKDOWN_BYTES) {
          return json(413, { error: "That document is too large to render as Word." });
        }

        // The hook strips highlight markers before sending; strip again so a non-hook caller cannot
        // ship marker syntax into a .docx, then gate on residual surrogates.
        markdown = stripRestoreHighlightMarkers(markdown);
        if (validateRestoredText(markdown).total > 0) {
          return json(422, {
            error: "The document still contains protection placeholders. Regenerate it before downloading.",
          });
        }

        let bytes: Uint8Array<ArrayBuffer>;
        try {
          ({ bytes } = await getRenderer().toDocx({ markdown, filename }));
        } catch (err) {
          if (err instanceof DocumentRendererUnavailableError) {
            const status = err.reason === "timeout" ? 504 : 502;
            return json(status, { error: "Word export is unavailable right now. Try again shortly." });
          }
          return json(500, { error: reason(err, "Could not render that document.") });
        }

        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": DOCX_CONTENT_TYPE,
            "content-disposition": `attachment; filename="${safeDocxFilename(filename)}"`,
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
