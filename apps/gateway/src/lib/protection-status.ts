import { protectionStatusSchema } from "@serovaai/ficta-contract";
import { type ProtectionStatusOk, type RegistryProtectionStatus } from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import type { ProxyCallResult } from "@/lib/proxy-result";

export type ProtectionStatus = ProxyCallResult<ProtectionStatusOk>;
export type { ProtectionStatusOk };
export const isProtectionStatusOk = (value: unknown): value is ProtectionStatusOk =>
  protectionStatusSchema.safeParse(value).success;

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
  const { fictaControlErrorStatus, GatewayFictaCompatibilityError, gatewayFictaControlClient } =
    await import("@/lib/ficta-control-client.server");
  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

  try {
    const client = await gatewayFictaControlClient({
      requiredCapability: "status",
      signal: controller.signal,
    });
    const json: unknown = await client.status(undefined, { signal: controller.signal });
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
    if (err instanceof GatewayFictaCompatibilityError) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: err.message,
      };
    }
    const httpStatus = fictaControlErrorStatus(err);
    if (httpStatus !== undefined) {
      return {
        ok: false,
        proxyUrl,
        status: "bad_response",
        message: `ficta proxy status returned HTTP ${httpStatus}; restart the proxy so the web UI can show protection posture.`,
      };
    }
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
