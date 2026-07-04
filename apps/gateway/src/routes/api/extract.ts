import { createFileRoute } from "@tanstack/react-router";
import { scopeFromAuth } from "../../lib/auth/guards.server";
import { getActiveProvider } from "../../lib/auth/provider.server";
import { DocumentConverterUnavailableError, getConverter } from "../../lib/documents/converter.server";
import { MAX_DOCUMENT_BYTES } from "../../lib/file-attachments";

/**
 * Turns an uploaded PDF/DOCX into Markdown text via the document-converter sidecar, so the browser (which
 * can only read plain-text files) can attach documents. The returned Markdown is treated as an ordinary
 * text attachment by the client and flows through the existing redaction path — this route does NOT talk
 * to the model or persist anything; the raw bytes live only for the duration of the conversion call.
 *
 * This is the app's first server-side binary path (chat is all client-side text inlining), hence the
 * explicit size cap here rather than relying on the composer's client-side check alone.
 *
 * Unlike /api/chat (whose SSE client only reads `statusText`), this route is called with plain `fetch`,
 * so errors return a JSON `{ error }` body the composer surfaces as an upload warning. Conversion failure
 * fails closed: no attachment is produced, so an un-extracted document is never silently sent.
 */
export const Route = createFileRoute("/api/extract")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Defense in depth: the UI is gated, but re-verify the session on the route that reaches the
        // sidecar. In `none` mode requiresAuth is false, so this is a no-op.
        const auth = await (await getActiveProvider()).getAuthState();
        const scope = scopeFromAuth(auth);
        if (auth.requiresAuth && !scope) return json(401, { error: "Sign in to attach documents." });

        let file: File;
        try {
          const form = await request.formData();
          const value = form.get("file");
          if (!(value instanceof Blob) || typeof (value as File).name !== "string") {
            throw new Error('no "file" field in the upload');
          }
          file = value as File;
        } catch (err) {
          return json(400, { error: reason(err, "Malformed upload.") });
        }

        if (file.size === 0) return json(400, { error: "That file is empty." });
        if (file.size > MAX_DOCUMENT_BYTES) {
          return json(413, { error: "That document is too large to extract. Split it and try again." });
        }

        let markdown: string;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await getConverter().toMarkdown({
            bytes,
            filename: file.name || "document",
            contentType: file.type || "application/octet-stream",
          });
          markdown = result.markdown.trim();
        } catch (err) {
          if (err instanceof DocumentConverterUnavailableError) {
            const status = err.reason === "timeout" ? 504 : 502;
            return json(status, { error: "Document extraction is unavailable right now. Paste the text instead." });
          }
          return json(500, { error: reason(err, "Could not extract that document.") });
        }

        // A scanned image with no OCR text yields empty Markdown. Refuse rather than attach a blank file —
        // the user would think the document was protected when there was nothing to redact.
        if (!markdown) {
          return json(422, {
            error: `No selectable text was found in ${file.name || "that document"} (it may be a scanned image).`,
          });
        }

        return json(200, { markdown, name: file.name || "document" });
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

function reason(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}
