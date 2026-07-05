import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/auth/guards.server";
import { proxyBaseUrl } from "@/lib/protection-status";

export type ProtectionStatsSurface = "body" | "query string" | "non-auth headers";

export interface ProtectionHit {
  name: string;
  source: string;
  plugin?: string;
  kind?: "secret" | "pii" | "custom";
  confidence?: "exact" | "high" | "probabilistic";
}

export interface ProtectionStatsTotals {
  events: number;
  affectedRequests: number;
  redactedValues: number;
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
  restoredValues: number;
  withheldFromToolsValues: number;
}

export interface ProtectionStatsBucket {
  name: string;
  requests: number;
  redactedValues: number;
  survivingValues: number;
  blockedRequests: number;
  keptOutOfModelValues: number;
}

export interface ProtectionStatsLabelBucket extends ProtectionStatsBucket {
  source: string;
  plugin?: string;
  kind?: ProtectionHit["kind"];
  confidence?: ProtectionHit["confidence"];
}

export interface ProtectionStatsEvent {
  index: number;
  at: string;
  requestId?: number;
  method: string;
  path: string;
  wire: string;
  route?: string;
  model: string;
  surface: ProtectionStatsSurface;
  redactedValues: number;
  survivingValues: number;
  blocked: boolean;
  redactedHits: ProtectionHit[];
  survivingHits: ProtectionHit[];
}

export interface ProtectionStatsSnapshot {
  version: 1;
  path: string;
  startedAt: string;
  updatedAt: string;
  totals: ProtectionStatsTotals;
  byModel: ProtectionStatsBucket[];
  bySurface: ProtectionStatsBucket[];
  byWire: ProtectionStatsBucket[];
  byLabel: ProtectionStatsLabelBucket[];
  events: ProtectionStatsEvent[];
}

export interface ProtectionStatsOk {
  ok: true;
  service: "ficta";
  stats: ProtectionStatsSnapshot;
}

export interface ProtectionStatsError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProtectionStats = ProtectionStatsOk | ProtectionStatsError;

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
    const res = await fetch(`${proxyUrl}/__ficta/protection-stats`, {
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

export function isProtectionStatsOk(value: unknown): value is ProtectionStatsOk {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isStatsSnapshot(value.stats)) return false;
  return true;
}

function isStatsSnapshot(value: unknown): value is ProtectionStatsSnapshot {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.path === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isTotals(value.totals) &&
    isBucketArray(value.byModel) &&
    isBucketArray(value.bySurface) &&
    isBucketArray(value.byWire) &&
    isLabelBucketArray(value.byLabel) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent)
  );
}

function isTotals(value: unknown): value is ProtectionStatsTotals {
  if (!isRecord(value)) return false;
  return (
    typeof value.events === "number" &&
    typeof value.affectedRequests === "number" &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blockedRequests === "number" &&
    typeof value.keptOutOfModelValues === "number" &&
    typeof value.restoredValues === "number" &&
    typeof value.withheldFromToolsValues === "number"
  );
}

function isBucketArray(value: unknown): value is ProtectionStatsBucket[] {
  return Array.isArray(value) && value.every(isBucket);
}

function isBucket(value: unknown): value is ProtectionStatsBucket {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.requests === "number" &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blockedRequests === "number" &&
    typeof value.keptOutOfModelValues === "number"
  );
}

function isLabelBucketArray(value: unknown): value is ProtectionStatsLabelBucket[] {
  return Array.isArray(value) && value.every(isLabelBucket);
}

function isLabelBucket(value: unknown): value is ProtectionStatsLabelBucket {
  if (!isRecord(value) || !isBucket(value)) return false;
  return (
    typeof value.source === "string" &&
    (value.plugin === undefined || typeof value.plugin === "string") &&
    (value.kind === undefined || isHitKind(value.kind)) &&
    (value.confidence === undefined || isHitConfidence(value.confidence))
  );
}

function isEvent(value: unknown): value is ProtectionStatsEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.index === "number" &&
    typeof value.at === "string" &&
    (value.requestId === undefined || typeof value.requestId === "number") &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    typeof value.wire === "string" &&
    (value.route === undefined || typeof value.route === "string") &&
    typeof value.model === "string" &&
    isSurface(value.surface) &&
    typeof value.redactedValues === "number" &&
    typeof value.survivingValues === "number" &&
    typeof value.blocked === "boolean" &&
    Array.isArray(value.redactedHits) &&
    value.redactedHits.every(isHit) &&
    Array.isArray(value.survivingHits) &&
    value.survivingHits.every(isHit)
  );
}

function isHit(value: unknown): value is ProtectionHit {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    (value.plugin === undefined || typeof value.plugin === "string") &&
    (value.kind === undefined || isHitKind(value.kind)) &&
    (value.confidence === undefined || isHitConfidence(value.confidence))
  );
}

function isSurface(value: unknown): value is ProtectionStatsSurface {
  return value === "body" || value === "query string" || value === "non-auth headers";
}

function isHitKind(value: unknown): value is NonNullable<ProtectionHit["kind"]> {
  return value === "secret" || value === "pii" || value === "custom";
}

function isHitConfidence(value: unknown): value is NonNullable<ProtectionHit["confidence"]> {
  return value === "exact" || value === "high" || value === "probabilistic";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
