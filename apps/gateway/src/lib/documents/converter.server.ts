/**
 * Document → Markdown conversion seam. This is the missing half of the "attach a PDF/DOCX" flow: ficta's
 * proxy already redacts and restores whatever text reaches it, but the browser can only read plain-text
 * files. This seam turns an uploaded document into Markdown text; that text then rides the *existing*
 * attachment path (inlined into the chat message → /api/chat → ficta proxy → Presidio redaction), so no
 * new PII code is needed here.
 *
 * Modelled on the ficta package's presidio-recognizer.ts: an out-of-process REST sidecar that ficta does
 * NOT lifecycle-manage — you run it (markitdown or docling, e.g. via Docker) and point
 * `FICTA_DOC_CONVERTER_URL` at it. Both backends speak one uniform contract so this client stays
 * backend-agnostic (the sidecar normalizes; see sidecars/document-converter/ for the reference wrapper):
 *   - POST {url}/convert   multipart/form-data, field `file`  →  200 { markdown: string }
 *   - GET  {url}/health                                       →  200
 *
 * Redaction-safety note: extraction fidelity is a security property. ficta's recognizers are
 * format-anchored (SSN pattern, Luhn-checked cards); if a converter mangles a table or drops OCR text,
 * an entity can split or vanish, the recognizers won't match it, and it would reach the vendor
 * un-redacted. That is the reason docling (better layout/OCR) is a swap-in for scanned legal PDFs. The
 * proxy's fail-closed leak gate only backstops *known* values — it cannot catch PII that was never seen.
 *
 * Server-only: imported from the /api/extract route. The raw document is handled in-memory and forwarded
 * to the sidecar; it is never persisted here.
 */

const DEFAULT_URL = "http://127.0.0.1:5003";
const DEFAULT_BACKEND: ConverterBackend = "markitdown";
/** Conversion — especially docling with OCR — is far slower than a Presidio analyze call, so the budget
 *  is generous. The route still returns promptly on the common (small, text-based) document. */
const DEFAULT_TIMEOUT_MS = 30_000;

export type ConverterBackend = "markitdown" | "docling";

export interface ConverterConfig {
  url: string;
  /** Informational: which sidecar the operator runs. Both speak the same /convert contract. */
  backend: ConverterBackend;
  /** Wall-clock budget for one conversion. */
  timeoutMs: number;
}

/** A document to convert. Decoupled from the DOM `File` so it is trivial to construct in tests. The
 *  buffer is pinned to `ArrayBuffer` (not the generic `ArrayBufferLike`) so it is a valid `BlobPart`. */
export interface DocumentInput {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  contentType: string;
}

export interface ConversionResult {
  markdown: string;
}

/** The conversion boundary. One REST implementation today; a future in-browser/JS converter (pdf.js +
 *  mammoth) or a docling-serve adapter is a second implementation behind this same interface. */
export interface DocumentConverter {
  toMarkdown(input: DocumentInput): Promise<ConversionResult>;
}

export type ConverterFailureReason = "unreachable" | "timeout" | "http_error" | "bad_response";

/** Typed backend failure. `detail` is safe metadata (status code, host, budget) — never document text. */
export class DocumentConverterUnavailableError extends Error {
  constructor(
    readonly reason: ConverterFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `document converter ${reason}: ${detail}` : `document converter ${reason}`);
    this.name = "DocumentConverterUnavailableError";
  }
}

/** Read converter config from env, with code fallbacks. */
export function converterConfig(env: NodeJS.ProcessEnv = process.env): ConverterConfig {
  return {
    url: stripTrailingSlash(env.FICTA_DOC_CONVERTER_URL?.trim() || DEFAULT_URL),
    backend: env.FICTA_DOC_CONVERTER_BACKEND?.trim().toLowerCase() === "docling" ? "docling" : DEFAULT_BACKEND,
    timeoutMs: readPositiveInt(env.FICTA_DOC_CONVERTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

const restDocumentConverter: DocumentConverter = {
  async toMarkdown({ bytes, filename, contentType }) {
    const config = converterConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: contentType || "application/octet-stream" }),
        filename || "document",
      );

      let res: Response;
      try {
        res = await fetch(`${config.url}/convert`, { method: "POST", body: form, signal: controller.signal });
      } catch (err) {
        if (isAbortError(err)) throw new DocumentConverterUnavailableError("timeout", `${config.timeoutMs}ms`);
        throw new DocumentConverterUnavailableError("unreachable", safeHost(config.url));
      }
      if (!res.ok) throw new DocumentConverterUnavailableError("http_error", String(res.status));

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new DocumentConverterUnavailableError("bad_response", "invalid JSON");
      }
      if (!isRecord(json) || typeof json.markdown !== "string") {
        throw new DocumentConverterUnavailableError("bad_response", "missing markdown");
      }
      return { markdown: json.markdown };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** The active converter. A single REST backend today; branch here when a JS-native converter lands. */
export function getConverter(): DocumentConverter {
  return restDocumentConverter;
}

/** GET /health for a reachability check. Never throws — returns a safe verdict. */
export async function checkConverterHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; url: string; backend: ConverterBackend; detail?: string }> {
  const config = converterConfig(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.url}/health`, { signal: controller.signal });
    return res.ok
      ? { ok: true, url: config.url, backend: config.backend }
      : { ok: false, url: config.url, backend: config.backend, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      url: config.url,
      backend: config.backend,
      detail: isAbortError(err) ? `timeout after ${config.timeoutMs}ms` : connectionErrorCode(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Node's fetch wraps the transport failure in `err.cause`; surface its code (e.g. ECONNREFUSED). */
function connectionErrorCode(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : "connection failed";
}

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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
