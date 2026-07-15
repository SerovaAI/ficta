import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";

/**
 * A request body arrived with a Content-Encoding the proxy could not decode. The body was never
 * screened, so the caller must refuse to forward it (fail-closed) rather than pass opaque bytes —
 * a compressed body would otherwise carry registered values straight past redaction.
 */
export class RequestBodyDecodeError extends Error {
  constructor(
    readonly encoding: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyDecodeError";
  }
}

// Ceiling on the decoded size of a single request body. Generous (model requests can carry
// base64 attachments) while still bounding a decompression bomb to something survivable.
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

// The compressed input is bounded at the same ceiling — compression never legitimately grows a
// body past its decoded size by more than a rounding error, so anything larger is hostile.
const MAX_ENCODED_BYTES = MAX_DECODED_BYTES;

// Real clients apply one coding, occasionally two. A longer chain buys nothing legitimate but lets
// an attacker demand MAX_DECODED_BYTES of synchronous decompression work per listed coding.
const MAX_CODING_STAGES = 4;

/**
 * Decode a request body per its Content-Encoding header so redaction screens the real text
 * (agents such as Pi zstd-compress their Codex-backend POSTs). Supports the registered HTTP
 * codings node:zlib can decode — gzip, deflate, br, zstd — including comma-separated chains,
 * applied in reverse order of application. Returns the decoded bytes plus whether any coding
 * was removed (when true the caller must drop the Content-Encoding header before forwarding).
 * Throws RequestBodyDecodeError on an unknown coding, an undecodable or oversized payload, or a
 * coding chain longer than any legitimate client produces.
 */
export function decodeRequestBody(
  body: Uint8Array,
  contentEncoding: string | null | undefined,
): { body: Uint8Array; decoded: boolean } {
  const codings = (contentEncoding ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== "identity");
  if (codings.length === 0 || body.length === 0) return { body, decoded: false };
  if (codings.length > MAX_CODING_STAGES) {
    throw new RequestBodyDecodeError(
      codings.join(","),
      `request Content-Encoding chain has ${codings.length} codings (limit ${MAX_CODING_STAGES})`,
    );
  }
  if (body.length > MAX_ENCODED_BYTES) {
    throw new RequestBodyDecodeError(
      codings.join(","),
      `compressed request body is ${body.length} bytes (limit ${MAX_ENCODED_BYTES})`,
    );
  }

  let current = body;
  for (const coding of codings.reverse()) {
    try {
      current = decodeSingle(current, coding);
    } catch (err) {
      if (err instanceof RequestBodyDecodeError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new RequestBodyDecodeError(coding, `request body is not valid "${coding}" data: ${detail}`);
    }
  }
  return { body: current, decoded: true };
}

function decodeSingle(body: Uint8Array, coding: string): Uint8Array {
  const limit = { maxOutputLength: MAX_DECODED_BYTES };
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(body, limit);
    case "deflate":
      // Some clients send raw deflate despite the header meaning zlib-wrapped; accept both.
      try {
        return inflateSync(body, limit);
      } catch {
        return inflateRawSync(body, limit);
      }
    case "br":
      return brotliDecompressSync(body, limit);
    case "zstd":
      return zstdDecompressSync(body, limit);
    default:
      throw new RequestBodyDecodeError(coding, `unsupported request Content-Encoding "${coding}"`);
  }
}
