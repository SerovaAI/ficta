import { afterEach, describe, expect, it } from "vitest";
import { createModelAdapter } from "@/lib/model-adapter";

type WithClient = { client: { maxRetries: number; baseURL: string } };
const clientOf = (adapter: unknown) => (adapter as WithClient).client;
const originalProxyUrl = process.env.FICTA_PROXY_URL;

afterEach(() => {
  if (originalProxyUrl === undefined) delete process.env.FICTA_PROXY_URL;
  else process.env.FICTA_PROXY_URL = originalProxyUrl;
});

describe("createModelAdapter", () => {
  it("never lets the SDK replay a single-use protection ticket", () => {
    for (const provider of ["openai", "anthropic"] as const) {
      const ticketed = createModelAdapter({ provider, model: "m", apiKey: "k", protectionTicket: "ticket" });
      expect(clientOf(ticketed).maxRetries).toBe(0);
      const plain = createModelAdapter({ provider, model: "m", apiKey: "k" });
      expect(clientOf(plain).maxRetries).toBeGreaterThan(0);
    }
  });

  it("tolerates a trailing slash in FICTA_PROXY_URL", () => {
    process.env.FICTA_PROXY_URL = "http://127.0.0.1:8787/";
    expect(clientOf(createModelAdapter({ provider: "openai", model: "m", apiKey: "k" })).baseURL).toBe(
      "http://127.0.0.1:8787/v1",
    );
    expect(clientOf(createModelAdapter({ provider: "anthropic", model: "m", apiKey: "k" })).baseURL).toBe(
      "http://127.0.0.1:8787",
    );
  });
});
