import {
  capabilitiesSchema,
  FICTA_CONTROL_PROTOCOL_VERSION,
  type FictaCapabilities,
  type FictaExtensionCapability,
  type FictaControlClient,
} from "@serovaai/ficta-contract";

const CAPABILITIES_CACHE_MS = 60_000;

export type GatewayFictaCapability = "status" | "protection-preview" | FictaExtensionCapability;

interface CachedCapabilities {
  expiresAt: number;
  value: FictaCapabilities;
}

const capabilitiesByBaseUrl = new Map<string, CachedCapabilities>();

export class GatewayFictaCompatibilityError extends Error {
  override readonly name = "GatewayFictaCompatibilityError";
}

/** Perform and briefly cache Ficta's runtime compatibility handshake. */
export async function requireGatewayFictaCapability(
  client: Pick<FictaControlClient, "capabilities">,
  baseUrl: string,
  requiredCapability: GatewayFictaCapability,
  signal?: AbortSignal,
): Promise<void> {
  const now = Date.now();
  const cached = capabilitiesByBaseUrl.get(baseUrl);
  const capabilities =
    cached && cached.expiresAt > now ? cached.value : await readCapabilities(client, baseUrl, signal);

  if (!capabilities.capabilities.includes(requiredCapability)) {
    throw new GatewayFictaCompatibilityError(
      `The ficta proxy does not advertise the "${requiredCapability}" control capability; update ficta and Gateway together.`,
    );
  }
}

async function readCapabilities(
  client: Pick<FictaControlClient, "capabilities">,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<FictaCapabilities> {
  let response: unknown;
  try {
    response = await client.capabilities(undefined, { signal });
  } catch (error) {
    if (isConnectionOrAbortError(error)) throw error;
    throw new GatewayFictaCompatibilityError(
      "The ficta proxy does not support the control-plane compatibility handshake; update ficta and Gateway together.",
    );
  }

  const parsed = capabilitiesSchema.safeParse(response);
  if (!parsed.success) {
    throw new GatewayFictaCompatibilityError(
      `The ficta proxy uses an incompatible control protocol; Gateway requires protocol version ${FICTA_CONTROL_PROTOCOL_VERSION}.`,
    );
  }

  capabilitiesByBaseUrl.set(baseUrl, {
    expiresAt: Date.now() + CAPABILITIES_CACHE_MS,
    value: parsed.data,
  });
  return parsed.data;
}

function isConnectionOrAbortError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");
}
