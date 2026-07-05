import {
  FICTA_STATUS_PATH,
  isProtectionStatusOk,
  type ProtectionStatus,
  type ProtectionStatusOk,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";

export type { ProtectionStatus, ProtectionStatusOk };
export { isProtectionStatusOk };

const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
const STATUS_TIMEOUT_MS = 1500;

/**
 * Server-only status read. The browser asks this app, and the app asks the local ficta proxy, so the
 * proxy never needs browser CORS and the client receives only safe posture metadata — never values.
 */
export const fetchProtectionStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStatus> => {
  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

  try {
    const res = await fetch(`${proxyUrl}${FICTA_STATUS_PATH}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: `ficta proxy status returned HTTP ${res.status}; restart the proxy so the web UI can show protection posture.`,
      };
    }

    const json = (await res.json()) as unknown;
    if (!isProtectionStatusOk(json)) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: "ficta proxy status response was not understood; restart both dev servers.",
      };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      proxyUrl,
      status: "unreachable",
      message: `ficta proxy is unreachable at ${proxyUrl}; chat cannot be verified as protected until the proxy is running.`,
      detail: isAbortError(err) ? `timeout after ${STATUS_TIMEOUT_MS}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

/** Base URL of the local ficta proxy (server-only). Shared with the admin config read. */
export function proxyBaseUrl(): string {
  return stripTrailingSlash(process.env.FICTA_PROXY_URL ?? DEFAULT_PROXY_URL);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
