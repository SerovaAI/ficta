import { chat } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelAdapter, type ModelChoice } from "@/lib/model-adapter";

const originalProxyUrl = process.env.FICTA_PROXY_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalProxyUrl === undefined) delete process.env.FICTA_PROXY_URL;
  else process.env.FICTA_PROXY_URL = originalProxyUrl;
});

/**
 * Sends one chat turn through the adapter against a stubbed `fetch` that always answers a retryable 503
 * (with a zero retry delay). Returns the URL of every request the adapter's HTTP client made, so the
 * tests check real wire behaviour instead of the adapters' private fields.
 */
async function requestsFor(choice: ModelChoice): Promise<string[]> {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after-ms": "0" },
      });
    }),
  );
  try {
    const stream = chat({
      adapter: createModelAdapter(choice),
      messages: [{ role: "user", content: "hi" }],
      threadId: "t",
    });
    for await (const _chunk of stream) void _chunk;
  } catch {
    // The 503 may surface as a thrown error; only the requests made matter here.
  }
  return urls;
}

describe("createModelAdapter", () => {
  it("never lets the SDK replay a single-use protection ticket", async () => {
    for (const provider of ["openai", "anthropic"] as const) {
      const ticketed = await requestsFor({ provider, model: "m", apiKey: "k", protectionTicket: "ticket" });
      expect(ticketed, provider).toHaveLength(1);
      const plain = await requestsFor({ provider, model: "m", apiKey: "k" });
      expect(plain.length, provider).toBeGreaterThan(1);
    }
  });

  it("tolerates a trailing slash in FICTA_PROXY_URL", async () => {
    process.env.FICTA_PROXY_URL = "http://127.0.0.1:8787/";
    const choice = { model: "m", apiKey: "k", protectionTicket: "ticket" };
    const [openaiUrl] = await requestsFor({ provider: "openai", ...choice });
    expect(openaiUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/v1\/responses(\?|$)/);
    const [anthropicUrl] = await requestsFor({ provider: "anthropic", ...choice });
    expect(anthropicUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/v1\/messages(\?|$)/);
  });
});
