import { fictaOperatorErrorData } from "@serovaai/ficta-contract";
import {
  gatewayFictaControlClient,
  fictaControlErrorStatus,
  GatewayFictaCompatibilityError,
} from "./ficta-control-client.server";
import {
  EDITABLE_PROXY_CONFIG_KEYS,
  type EditableProxyConfigKey,
  type EditableProxyConfigValues,
  isProxyConfigOk,
  isProxyConfigUpdateOk,
  normalizePiiBackends,
  normalizeRestoreIntoToolsPolicy,
  PII_BACKEND_NAMES,
  type PiiBackendName,
  type ProxyConfigOk,
  type ProxyConfigUpdateOk,
  type RuntimeTraceCaptureOk,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/auth/guards.server";
import type { ProxyCallResult } from "@/lib/proxy-result";

export type EditableProxyConfigPatch = Partial<EditableProxyConfigValues>;
export type ProxyConfig = ProxyCallResult<ProxyConfigOk>;
export type ProxyConfigUpdate = ProxyCallResult<ProxyConfigUpdateOk>;
export type RuntimeTraceCaptureUpdate = ProxyCallResult<RuntimeTraceCaptureOk>;
export type { EditableProxyConfigKey, EditableProxyConfigValues, PiiBackendName };
export { isProxyConfigOk, isProxyConfigUpdateOk, PII_BACKEND_NAMES };

const CONFIG_TIMEOUT_MS = 1500;
const EDITABLE_PROXY_CONFIG_KEY_SET = new Set<string>(EDITABLE_PROXY_CONFIG_KEYS);

/**
 * Admin-only, server-only read of the proxy's effective configuration. `requireAdmin()` is the real
 * enforcement (route/dialog gating is just UX): the config JSON never reaches a non-admin browser,
 * and the proxy itself stays auth-free and loopback-bound.
 */
export const fetchProxyConfig = createServerFn({ method: "GET" }).handler(async (): Promise<ProxyConfig> => {
  await requireAdmin();

  const { proxyBaseUrl } = await import("@/lib/proxy-base.server");
  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

  try {
    const client = await gatewayFictaControlClient({ requiredCapability: "config", signal: controller.signal });
    const json = await client.config(undefined, { signal: controller.signal });
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
    if (err instanceof GatewayFictaCompatibilityError)
      return { ok: false, proxyUrl, status: "bad_response", message: err.message };
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

export const updateProxyConfig = createServerFn({ method: "POST" })
  .validator(validateEditablePatch)
  .handler(async ({ data }): Promise<ProxyConfigUpdate> => {
    await requireAdmin();

    const { proxyBaseUrl } = await import("@/lib/proxy-base.server");
    const proxyUrl = proxyBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

    try {
      const client = await gatewayFictaControlClient({ requiredCapability: "config", signal: controller.signal });
      const json = await client.updateConfig(data, { signal: controller.signal });
      if (!isProxyConfigUpdateOk(json)) {
        return {
          ok: false,
          proxyUrl,
          status: "bad_response",
          message:
            "ficta proxy config update response was not understood; the proxy and web app versions may be out of sync.",
        };
      }
      return json;
    } catch (err) {
      const operator = fictaOperatorErrorData(err);
      if (operator || err instanceof GatewayFictaCompatibilityError || fictaControlErrorStatus(err) !== undefined) {
        return { ok: false, proxyUrl, status: "bad_response", message: operator?.message ?? errorMessage(err) };
      }
      return {
        ok: false,
        proxyUrl,
        status: "unreachable",
        message: `ficta proxy is unreachable at ${proxyUrl}; start it to edit its configuration.`,
        detail: isAbortError(err) ? `timeout after ${CONFIG_TIMEOUT_MS}ms` : errorMessage(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

export const updateRuntimeTraceCapture = createServerFn({ method: "POST" })
  .validator((input: unknown): { enabled: boolean } => {
    if (!isRecord(input) || typeof input.enabled !== "boolean" || Object.keys(input).length !== 1) {
      throw new Error("invalid runtime trace capture update");
    }
    return { enabled: input.enabled };
  })
  .handler(async ({ data }): Promise<RuntimeTraceCaptureUpdate> => {
    await requireAdmin();

    const { proxyBaseUrl } = await import("@/lib/proxy-base.server");
    const proxyUrl = proxyBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

    try {
      const client = await gatewayFictaControlClient({
        requiredCapability: "trace-capture",
        signal: controller.signal,
      });
      const json = await client.updateTraceCapture(data, { signal: controller.signal });
      return json;
    } catch (err) {
      const operator = fictaOperatorErrorData(err);
      if (operator || err instanceof GatewayFictaCompatibilityError || fictaControlErrorStatus(err) !== undefined) {
        return { ok: false, proxyUrl, status: "bad_response", message: operator?.message ?? errorMessage(err) };
      }
      return {
        ok: false,
        proxyUrl,
        status: "unreachable",
        message: `ficta proxy is unreachable at ${proxyUrl}; start it to manage trace capture.`,
        detail: isAbortError(err) ? `timeout after ${CONFIG_TIMEOUT_MS}ms` : errorMessage(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

function validateEditablePatch(input: unknown): EditableProxyConfigPatch {
  if (!isRecord(input)) throw new Error("invalid proxy config patch");

  const patch: EditableProxyConfigPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE_PROXY_CONFIG_KEY_SET.has(key)) throw new Error("invalid proxy config field");
    const field = key as EditableProxyConfigKey;
    switch (field) {
      case "failClosed":
      case "piiEnabled":
      case "piiFailClosed":
      case "secretShapesEnabled":
      case "allowCustomUpstream":
        if (typeof value !== "boolean") throw new Error("invalid proxy config boolean");
        patch[field] = value;
        break;
      case "restoreIntoTools": {
        const policy = normalizeRestoreIntoToolsPolicy(value);
        if (policy === undefined) throw new Error("invalid proxy config restore-into-tools policy");
        patch[field] = policy;
        break;
      }
      case "piiBackends": {
        const normalized = normalizePiiBackends(value);
        if (normalized === undefined) throw new Error("invalid proxy config backends");
        patch[field] = normalized;
        break;
      }
      case "surrogateStyle":
        if (value !== "opaque" && value !== "typed") throw new Error("invalid proxy config surrogate style");
        patch[field] = value;
        break;
      case "piiPresidioUrl":
      case "piiOpenmedUrl":
        if (typeof value !== "string") throw new Error("invalid proxy config url");
        patch[field] = value;
        break;
    }
  }
  return patch;
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
