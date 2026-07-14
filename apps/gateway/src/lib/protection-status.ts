import {
  FICTA_STATUS_PATH,
  isProtectionStatusOk,
  type ProtectionStatusOk,
  type RegistryProtectionStatus,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import type { ProxyCallResult } from "@/lib/proxy-result";

export type ProtectionStatus = ProxyCallResult<ProtectionStatusOk>;
export type { ProtectionStatusOk };
export { isProtectionStatusOk };

/** Required-registry failures pause sends; relaxed/legacy proxy status remains non-blocking here. */
export function requiredRegistryBlock(status: ProtectionStatus | undefined): RegistryProtectionStatus | undefined {
  if (!status?.ok) return undefined;
  const registry = status.registry;
  return registry?.required && registry.status !== "ready" ? registry : undefined;
}

const STATUS_TIMEOUT_MS = 1500;

/**
 * Server-only status read. The browser asks this app, and the app asks the local ficta proxy, so the
 * proxy never needs browser CORS and the client receives only safe posture metadata — never values.
 */
export const fetchProtectionStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStatus> => {
  const { proxyBaseUrl } = await import("@/lib/proxy-base.server");
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
