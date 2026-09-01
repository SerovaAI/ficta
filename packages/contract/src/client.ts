import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { fictaControlContract } from "./contract.js";
import { decodeFictaControlError } from "./errors.js";

export type FictaControlClient = JsonifiedClient<ContractRouterClient<typeof fictaControlContract>>;

export interface CreateFictaControlClientOptions {
  baseUrl: string | URL;
  headers?: Headers | Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/** Create a fetch-based client for any conforming Ficta control-plane implementation. */
export function createFictaControlClient(options: CreateFictaControlClientOptions): FictaControlClient {
  const link = new OpenAPILink(fictaControlContract, {
    url: options.baseUrl,
    headers: options.headers,
    customErrorResponseBodyDecoder: decodeFictaControlError,
    ...(options.fetch
      ? {
          fetch: (request, init) => options.fetch?.(request, init) ?? globalThis.fetch(request, init),
        }
      : {}),
  });
  return createORPCClient<FictaControlClient>(link);
}
