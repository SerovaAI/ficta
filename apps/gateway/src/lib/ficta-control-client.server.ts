import {
  createFictaControlClient,
  fictaControlErrorData,
  fictaControlErrorStatus,
  type FictaControlClient,
} from "@serovaai/ficta-contract";
import {
  GatewayFictaCompatibilityError,
  requireGatewayFictaCapability,
  type GatewayFictaCapability,
} from "./ficta-capabilities.server";
import { proxyBaseUrl } from "./proxy-base.server";

export interface GatewayFictaControlClientOptions {
  headers?: Record<string, string>;
  requiredCapability: GatewayFictaCapability;
  signal?: AbortSignal;
}

export async function gatewayFictaControlClient(
  options: GatewayFictaControlClientOptions,
): Promise<FictaControlClient> {
  const baseUrl = proxyBaseUrl();
  const discoveryClient = createFictaControlClient({ baseUrl });
  await requireGatewayFictaCapability(discoveryClient, baseUrl, options.requiredCapability, options.signal);
  return options.headers ? createFictaControlClient({ baseUrl, headers: options.headers }) : discoveryClient;
}

export { fictaControlErrorData, fictaControlErrorStatus, GatewayFictaCompatibilityError };
