import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { fictaControlContract } from "./contract.js";
import {
  fictaExtensionContract,
  configSchema,
  configUpdateSchema,
  traceCaptureSchema,
  protectionStatsSchema,
  egressProofSchema,
  registryReloadSchema,
} from "./extensions.js";
import { capabilitiesSchema, healthSchema, protectionStatusSchema, protectionPreviewSchema } from "./schemas.js";
import { decodeFictaControlError } from "./errors.js";

export const fictaClientContract = { ...fictaControlContract, ...fictaExtensionContract };
export type FictaControlClient = JsonifiedClient<ContractRouterClient<typeof fictaClientContract>>;

export interface CreateFictaControlClientOptions {
  baseUrl: string | URL;
  headers?: Headers | Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/** Create a fetch-based client for any conforming Ficta control-plane implementation. */
export function createFictaControlClient(options: CreateFictaControlClientOptions): FictaControlClient {
  const link = new OpenAPILink(fictaClientContract, {
    url: options.baseUrl,
    headers: options.headers,
    customErrorResponseBodyDecoder: decodeFictaControlError,
    ...(options.fetch
      ? {
          fetch: (request, init) => options.fetch?.(request, init) ?? globalThis.fetch(request, init),
        }
      : {}),
  });
  const client = createORPCClient<FictaControlClient>(link);
  // Transport types alone do not validate responses from another engine.
  return {
    capabilities: async (...args) => capabilitiesSchema.parse(await client.capabilities(...args)),
    health: async (...args) => healthSchema.parse(await client.health(...args)),
    status: async (...args) => protectionStatusSchema.parse(await client.status(...args)),
    protectionPreview: async (...args) => protectionPreviewSchema.parse(await client.protectionPreview(...args)),
    protectionStats: async (...args) => protectionStatsSchema.parse(await client.protectionStats(...args)),
    egressProof: async (...args) => egressProofSchema.parse(await client.egressProof(...args)),
    config: async (...args) => configSchema.parse(await client.config(...args)),
    updateConfig: async (...args) => configUpdateSchema.parse(await client.updateConfig(...args)),
    traceCapture: async (...args) => traceCaptureSchema.parse(await client.traceCapture(...args)),
    updateTraceCapture: async (...args) => traceCaptureSchema.parse(await client.updateTraceCapture(...args)),
    registryReload: async (...args) => registryReloadSchema.parse(await client.registryReload(...args)),
  };
}
