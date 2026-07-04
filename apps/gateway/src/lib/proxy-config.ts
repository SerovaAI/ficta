import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/auth/guards.server";
import { proxyBaseUrl } from "@/lib/protection-status";

/**
 * Wire types for `GET /__ficta/config` on the ficta proxy. Duplicated by convention (like
 * protection-status.ts) — there is no shared package across the proxy/app boundary — and validated
 * at runtime by {@link isProxyConfigOk}, which fails closed to `bad_response` on any shape drift.
 * The payload is values-free posture metadata: booleans, enums, URLs — never secret values.
 */
export interface ProxyConfigPosture {
  protection: {
    failClosed: boolean;
    requireRegistry: boolean;
    globallyDisabled: boolean;
    redactPaths: boolean;
    restoreIntoTools: boolean;
    surrogateStyle: "opaque" | "typed";
  };
  detection: {
    pii: {
      standalone: boolean;
      agents: boolean;
      configuredBackend: string;
      failureMode: "fail-open" | "fail-closed";
    };
    secretShapes: {
      standalone: boolean;
      agents: boolean;
    };
  };
  transport: {
    host: string;
    port: number;
    upstreams: { anthropic: string; openai: string; chatgpt: string };
    forcedUpstream?: string;
    allowCustomUpstream: boolean;
    logLevel: string;
    logBodies: boolean;
    logDir: string;
  };
}

export interface ProxyConfigOk {
  ok: true;
  service: "ficta";
  config: ProxyConfigPosture;
}

export interface ProxyConfigError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProxyConfig = ProxyConfigOk | ProxyConfigError;

const CONFIG_TIMEOUT_MS = 1500;

/**
 * Admin-only, server-only read of the proxy's effective configuration. `requireAdmin()` is the real
 * enforcement (route/dialog gating is just UX): the config JSON never reaches a non-admin browser,
 * and the proxy itself stays auth-free and loopback-bound.
 */
export const fetchProxyConfig = createServerFn({ method: "GET" }).handler(async (): Promise<ProxyConfig> => {
  await requireAdmin();

  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

  try {
    const res = await fetch(`${proxyUrl}/__ficta/config`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: `ficta proxy config returned HTTP ${res.status}; restart the proxy to inspect its configuration.`,
      };
    }

    const json = (await res.json()) as unknown;
    if (!isProxyConfigOk(json)) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: "ficta proxy config response was not understood; the proxy and web app versions may be out of sync.",
      };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      proxyUrl,
      status: "unreachable",
      message: `ficta proxy is unreachable at ${proxyUrl}; start it to inspect its configuration.`,
      detail: isAbortError(err) ? `timeout after ${CONFIG_TIMEOUT_MS}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

export function isProxyConfigOk(value: unknown): value is ProxyConfigOk {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.service !== "ficta") return false;
  if (!isRecord(value.config)) return false;
  const { protection, detection, transport } = value.config;
  if (!isRecord(protection) || !isRecord(detection) || !isRecord(transport)) return false;
  if (!isRecord(detection.pii) || !isRecord(detection.secretShapes) || !isRecord(transport.upstreams)) return false;
  return (
    typeof protection.failClosed === "boolean" &&
    typeof protection.requireRegistry === "boolean" &&
    typeof protection.globallyDisabled === "boolean" &&
    typeof protection.redactPaths === "boolean" &&
    typeof protection.restoreIntoTools === "boolean" &&
    (protection.surrogateStyle === "opaque" || protection.surrogateStyle === "typed") &&
    typeof detection.pii.standalone === "boolean" &&
    typeof detection.pii.agents === "boolean" &&
    typeof detection.pii.configuredBackend === "string" &&
    (detection.pii.failureMode === "fail-open" || detection.pii.failureMode === "fail-closed") &&
    typeof detection.secretShapes.standalone === "boolean" &&
    typeof detection.secretShapes.agents === "boolean" &&
    typeof transport.host === "string" &&
    typeof transport.port === "number" &&
    typeof transport.upstreams.anthropic === "string" &&
    typeof transport.upstreams.openai === "string" &&
    typeof transport.upstreams.chatgpt === "string" &&
    (transport.forcedUpstream === undefined || typeof transport.forcedUpstream === "string") &&
    typeof transport.allowCustomUpstream === "boolean" &&
    typeof transport.logLevel === "string" &&
    typeof transport.logBodies === "boolean" &&
    typeof transport.logDir === "string"
  );
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
