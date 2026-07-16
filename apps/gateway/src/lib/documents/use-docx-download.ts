/**
 * The browser half of "Download as Word": turns a completed assistant message into a .docx via
 * POST /api/render and hands the bytes to the browser as a download. The markdown sent is the
 * restored, marker-free text the user is looking at — the render path never involves the model or
 * the proxy (see renderer.server.ts for why that is a security property, not an optimization).
 *
 * Auto-render: when the message finishes streaming and contains a closed `ficta:document` fence,
 * rendering starts immediately so the file is ready before the user reaches the button. The
 * whole-message fallback (no fence) renders only on an explicit click — auto-rendering every chat
 * message would spam the sidecar on nothing.
 *
 * Pre-check: residual FICTA_ surrogates are refused client-side with an inline explanation before
 * any round trip; /api/render re-checks server-side as the authority.
 */

import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stripRestoreHighlightMarkers } from "@/lib/restore-highlights";
import { validateRestoredText } from "@/lib/restore-validation";
import { documentDownloadSource } from "./document-blocks";
import { safeDocxFilename } from "./render";

export type DocxDownloadStatus = "unavailable" | "idle" | "rendering" | "ready" | "blocked" | "error";

export interface DocxDownload {
  status: DocxDownloadStatus;
  /** User-facing explanation for `blocked` and `error`. */
  message?: string;
  /** Renders (or reuses the prepared file) and triggers the browser download. No-op when blocked. */
  download: () => void;
}

/** Lets the document card deep inside the markdown tree reach the bubble-level download state. */
export const DocxDownloadContext = createContext<DocxDownload | null>(null);

const BLOCKED_MESSAGE = "Contains protection placeholders — ask for the document to be regenerated first.";
const FAILED_MESSAGE = "Word export failed. Click to retry.";

export function useDocxDownload({ text, streaming }: { text: string; streaming: boolean }): DocxDownload {
  const source = useMemo(() => (streaming ? undefined : documentDownloadSource(text)), [streaming, text]);
  const markdown = useMemo(() => (source ? stripRestoreHighlightMarkers(source.markdown) : undefined), [source]);
  const blocked = useMemo(() => (markdown ? validateRestoredText(markdown).total > 0 : false), [markdown]);

  // One prepared file per markdown value; a regenerated message simply misses the cache.
  const prepared = useRef<{ markdown: string; blob: Blob; filename: string }>(null);
  const inflight = useRef<Promise<Blob> | null>(null);
  const [state, setState] = useState<{ markdown: string; status: "rendering" | "ready" | "error"; message?: string }>();

  const filename = safeDocxFilename(source?.title);

  const ensureRendered = useCallback(async (): Promise<Blob> => {
    if (!markdown) throw new Error("nothing to render");
    if (prepared.current?.markdown === markdown) return prepared.current.blob;
    if (inflight.current) return inflight.current;

    setState({ markdown, status: "rendering" });
    const request = (async () => {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, filename }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : FAILED_MESSAGE);
      }
      return res.blob();
    })();
    inflight.current = request;

    try {
      const blob = await request;
      prepared.current = { markdown, blob, filename };
      setState({ markdown, status: "ready" });
      return blob;
    } catch (err) {
      setState({ markdown, status: "error", message: err instanceof Error ? err.message : FAILED_MESSAGE });
      throw err;
    } finally {
      inflight.current = null;
    }
  }, [filename, markdown]);

  const download = useCallback(() => {
    if (!markdown || blocked) return;
    void ensureRendered()
      .then((blob) => saveBlob(blob, filename))
      .catch(() => {}); // state already carries the error; the button becomes the retry
  }, [blocked, ensureRendered, filename, markdown]);

  // Auto-render exactly once, at the streaming → completed transition, and only for a real fence.
  // Historical messages mount already-complete (no transition) and are left alone.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    const finished = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (finished && source?.fromFence && !blocked) void ensureRendered().catch(() => {});
  }, [blocked, ensureRendered, source, streaming]);

  if (!markdown) return { status: "unavailable", download };
  if (blocked) return { status: "blocked", message: BLOCKED_MESSAGE, download };
  if (state?.markdown === markdown) return { status: state.status, message: state.message, download };
  return { status: "idle", download };
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
