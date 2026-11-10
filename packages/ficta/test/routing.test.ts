import { describe, expect, it } from "vitest";
import { loadConfig, resolveTarget } from "../src/config.js";

const cfg = loadConfig();
const H = (o: Record<string, string>) => new Headers(o);

describe("resolveTarget", () => {
  it("Claude → Anthropic", () => {
    expect(resolveTarget(cfg, "/v1/messages", "", H({})).url).toContain("api.anthropic.com/v1/messages");
  });

  it("OpenAI chat → OpenAI", () => {
    expect(resolveTarget(cfg, "/v1/chat/completions", "", H({})).url).toContain("api.openai.com");
  });

  it("API-key Codex (/v1/responses, no account header) → OpenAI", () => {
    expect(resolveTarget(cfg, "/v1/responses", "", H({})).url).toBe("https://api.openai.com/v1/responses");
  });

  it("OAuth Codex (/v1/responses + account header) → ChatGPT backend, rewritten", () => {
    const r = resolveTarget(cfg, "/v1/responses", "", H({ "chatgpt-account-id": "acct" }));
    expect(r.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("OAuth model registry (/v1/models) → ChatGPT backend", () => {
    const r = resolveTarget(cfg, "/v1/models", "", H({ "chatgpt-account-id": "acct" }));
    expect(r.url).toContain("/backend-api/codex/models");
  });

  it("Anthropic model registry (/v1/models + anthropic-version) → Anthropic", () => {
    const r = resolveTarget(cfg, "/v1/models", "?limit=100", H({ "anthropic-version": "2023-06-01" }));
    expect(r.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    const one = resolveTarget(cfg, "/v1/models/claude-fable-5-2", "", H({ "x-api-key": "k" }));
    expect(one.url).toBe("https://api.anthropic.com/v1/models/claude-fable-5-2");
  });

  it("API-key OpenAI model registry (/v1/models, no Anthropic headers) → OpenAI", () => {
    const r = resolveTarget(cfg, "/v1/models", "", H({ authorization: "Bearer sk-x" }));
    expect(r.url).toBe("https://api.openai.com/v1/models");
  });

  it("ChatGPT housekeeping (/backend-api/*) → ChatGPT passthrough", () => {
    expect(resolveTarget(cfg, "/backend-api/ps/mcp", "", H({})).url).toBe("https://chatgpt.com/backend-api/ps/mcp");
  });
});
