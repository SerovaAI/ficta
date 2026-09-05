import { gatewayFictaControlClient, GatewayFictaCompatibilityError } from "./ficta-control-client.server";
import { isProtectionStatsOk, type ProtectionStatsOk, type ProtectionStatsSnapshot } from "@serovaai/ficta-protocol";
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
    const client = await gatewayFictaControlClient({
      requiredCapability: "protection-stats",
      signal: controller.signal,
    });
    const json = await client.protectionStats(undefined, { signal: controller.signal });
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
    if (err instanceof GatewayFictaCompatibilityError)
      return { ok: false, proxyUrl, status: "bad_response", message: err.message };
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
