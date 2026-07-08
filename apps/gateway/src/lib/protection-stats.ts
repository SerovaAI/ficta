import {
  FICTA_PROTECTION_STATS_PATH,
  isProtectionStatsOk,
  type ProtectionStats,
  type ProtectionStatsLabelBucket,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/auth/guards.server";
import { proxyBaseUrl } from "@/lib/protection-status";

export type { ProtectionStats, ProtectionStatsLabelBucket };
export { isProtectionStatsOk };

const STATS_TIMEOUT_MS = 1500;

/**
 * Admin-only, server-only read of values-free redaction proof for the current proxy run. The proxy
 * endpoint intentionally returns counts and labels only; never protected literals or transcript text.
 */
export const fetchProtectionStats = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStats> => {
  await requireAdmin();

  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATS_TIMEOUT_MS);

  try {
    const res = await fetch(`${proxyUrl}${FICTA_PROTECTION_STATS_PATH}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: `ficta proxy proof returned HTTP ${res.status}; restart the proxy to inspect redaction proof.`,
      };
    }

    const json = (await res.json()) as unknown;
    if (!isProtectionStatsOk(json)) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: "ficta proxy proof response was not understood; the proxy and web app versions may be out of sync.",
      };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      proxyUrl,
      status: "unreachable",
      message: `ficta proxy is unreachable at ${proxyUrl}; start it to inspect redaction proof.`,
      detail: isAbortError(err) ? `timeout after ${STATS_TIMEOUT_MS}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
