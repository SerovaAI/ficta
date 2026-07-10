import {
  FICTA_PROTECTION_STATS_PATH,
  isProtectionStatsOk,
  type ProtectionStatsOk,
  type ProtectionStatsSnapshot,
} from "@serovaai/ficta-protocol";
import { proxyBaseUrl } from "@/lib/proxy-base.server";
import type { ProxyCallResult } from "@/lib/proxy-result";
import { getStorage } from "@/lib/storage/storage.server";
import type { ProtectionStatsDailySummary } from "@/lib/storage/types";

const STATS_TIMEOUT_MS = 1500;

export type ProtectionStats = ProxyCallResult<ProtectionStatsOk>;

export async function readCurrentProtectionStats(orgId: string): Promise<ProtectionStats> {
  const proxyUrl = proxyBaseUrl();
  const proof = await readProtectionStatsFromProxy(proxyUrl);
  if (isProtectionStatsOk(proof)) await ingestProtectionStats(orgId, proxyUrl, proof.stats);
  return proof;
}

export async function listProtectionStatsHistory(orgId: string): Promise<ProtectionStatsDailySummary[]> {
  return (await getStorage()).listProtectionStatsDaily(orgId);
}

export async function recordProtectionStatsTrend(orgId: string): Promise<void> {
  await readCurrentProtectionStats(orgId);
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
