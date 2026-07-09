import {
  FICTA_PROTECTION_STATS_PATH,
  isProtectionStatsOk,
  type ProtectionStats,
  type ProtectionStatsLabelBucket,
  type ProtectionStatsSnapshot,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope } from "@/lib/auth/guards.server";
import { proxyBaseUrl } from "@/lib/protection-status";
import { getStorage } from "@/lib/storage/storage.server";
import type { ProtectionStatsDailySummary } from "@/lib/storage/types";

export type { ProtectionStats, ProtectionStatsDailySummary, ProtectionStatsLabelBucket };
export { isProtectionStatsOk };

const STATS_TIMEOUT_MS = 1500;

/**
 * Admin-only, server-only read of values-free redaction proof for the current proxy run. The proxy
 * endpoint intentionally returns counts and labels only; never protected literals or transcript text.
 */
export const fetchProtectionStats = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStats> => {
  const { orgId } = await requireAdminScope();
  const proxyUrl = proxyBaseUrl();
  const proof = await readProtectionStatsFromProxy(proxyUrl);
  if (isProtectionStatsOk(proof)) await ingestProtectionStats(orgId, proxyUrl, proof.stats);
  return proof;
});

export const fetchProtectionStatsHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProtectionStatsDailySummary[]> => {
    const { orgId } = await requireAdminScope();
    return (await getStorage()).listProtectionStatsDaily(orgId);
  },
);

export async function recordProtectionStatsTrend(orgId: string): Promise<void> {
  const proxyUrl = proxyBaseUrl();
  const proof = await readProtectionStatsFromProxy(proxyUrl);
  if (isProtectionStatsOk(proof)) await ingestProtectionStats(orgId, proxyUrl, proof.stats);
}

async function readProtectionStatsFromProxy(proxyUrl: string): Promise<ProtectionStats> {
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
}

async function ingestProtectionStats(
  orgId: string,
  proxyUrl: string,
  snapshot: ProtectionStatsSnapshot,
): Promise<void> {
  await (await getStorage()).ingestProtectionStatsSnapshot(orgId, proxyUrl, snapshot);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
