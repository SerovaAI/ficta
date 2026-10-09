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

/** A response that arrived but failed the contract's validation: a version mismatch, not an outage. */
export function isFictaResponseShapeError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

export { fictaControlErrorData, fictaControlErrorStatus, GatewayFictaCompatibilityError };
