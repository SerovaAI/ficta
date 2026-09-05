import type { FictaControlClient } from "@serovaai/ficta-contract";
import { describe, expect, it, vi } from "vitest";
import { GatewayFictaCompatibilityError, requireGatewayFictaCapability } from "@/lib/ficta-capabilities.server";

function clientWithCapabilities(
  capabilities: (...args: unknown[]) => Promise<unknown>,
): Pick<FictaControlClient, "capabilities"> {
  return { capabilities } as unknown as Pick<FictaControlClient, "capabilities">;
}

function compatibleCapabilities() {
  return {
    ok: true,
    service: "ficta",
    protocolVersion: 1,
    capabilities: ["health", "status", "protection-preview"],
  };
}

describe("requireGatewayFictaCapability", () => {
  it("performs one cached handshake for procedures at the same proxy", async () => {
    const capabilities = vi.fn(async () => compatibleCapabilities());
    const client = clientWithCapabilities(capabilities);
    const baseUrl = "http://ficta-cache-test";

    await requireGatewayFictaCapability(client, baseUrl, "status");
    await requireGatewayFictaCapability(client, baseUrl, "protection-preview");

    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it("rejects a proxy that does not advertise the requested procedure", async () => {
    const client = clientWithCapabilities(async () => ({
      ...compatibleCapabilities(),
      capabilities: ["health", "status"],
    }));

    await expect(
      requireGatewayFictaCapability(client, "http://ficta-missing-test", "protection-preview"),
    ).rejects.toEqual(expect.any(GatewayFictaCompatibilityError));
  });

  it("rejects an incompatible protocol response", async () => {
    const client = clientWithCapabilities(async () => ({
      ...compatibleCapabilities(),
      protocolVersion: 2,
    }));

    await expect(requireGatewayFictaCapability(client, "http://ficta-version-test", "status")).rejects.toThrow(
      "requires protocol version 1",
    );
  });

  it("preserves connection errors and retries discovery later", async () => {
    const capabilities = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(compatibleCapabilities());
    const client = clientWithCapabilities(capabilities);
    const baseUrl = "http://ficta-retry-test";

    await expect(requireGatewayFictaCapability(client, baseUrl, "status")).rejects.toThrow("fetch failed");
    await requireGatewayFictaCapability(client, baseUrl, "status");

    expect(capabilities).toHaveBeenCalledTimes(2);
  });
});

it("does not call an optional interface when the proxy omits its capability", async () => {
  const client = clientWithCapabilities(async () => compatibleCapabilities());
  await expect(
    requireGatewayFictaCapability(client, "http://ficta-no-operator-profile", "registry-reload"),
  ).rejects.toThrow('does not advertise the "registry-reload"');
});
