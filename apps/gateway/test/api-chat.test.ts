import type { FictaControlClient } from "@serovaai/ficta-contract";
import { gatewayFictaControlClient } from "@/lib/ficta-control-client.server";
vi.mock("@/lib/ficta-control-client.server", () => ({ gatewayFictaControlClient: vi.fn() }));
import { describe, expect, it, vi } from "vitest";
import {
  cleanProtectionTicket,
  prepareStoredThreadProtection,
  latestUserText,
  messagesForModel,
  modelOptionsForProvider,
  requiresProtectionReviewTicket,
  resolveChatTraceEnabled,
  resolveRequestedReasoningEffort,
} from "@/routes/api/chat";

const SURROGATE = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";

describe("latestUserText", () => {
  it("prepares only the current user turn rather than serializing a large transcript", () => {
    const transcript = [
      { role: "user", parts: [{ type: "text", content: "x".repeat(2 * 1024 * 1024) }] },
      { role: "assistant", parts: [{ type: "text", content: "done" }] },
      { role: "user", parts: [{ type: "text", content: "current protected turn" }] },
    ];
    expect(latestUserText(transcript)).toBe("current protected turn");
  });
});

describe("messagesForModel", () => {
  it("removes persisted Ficta annotations before provider conversion", () => {
    const messages = [
      {
        role: "user",
        parts: [
          {
            type: "text",
            content: "Email jane.doe@example.com",
            metadata: {
              fictaProtection: [
                {
                  start: 6,
                  end: 26,
                  surrogate: SURROGATE,
                  origin: "detected",
                  direction: "redacted",
                },
              ],
            },
          },
        ],
      },
    ];

    expect(messagesForModel(messages)).toEqual([
      { role: "user", parts: [{ type: "text", content: "Email jane.doe@example.com" }] },
    ]);
  });
});

describe("requiresProtectionReviewTicket", () => {
  it("fails closed when an administrator requires analysis or review", () => {
    expect(requiresProtectionReviewTicket({ protectionReviewMinimum: "adaptive" }, undefined)).toBe(true);
    expect(requiresProtectionReviewTicket({ protectionReviewMinimum: "always" }, undefined)).toBe(true);
    expect(requiresProtectionReviewTicket({ protectionReviewMinimum: "always" }, "ticket")).toBe(false);
    expect(requiresProtectionReviewTicket({ protectionReviewMinimum: "off" }, undefined)).toBe(false);
    expect(requiresProtectionReviewTicket({}, undefined)).toBe(false);
  });
});

describe("resolveChatTraceEnabled", () => {
  it("uses persisted thread trace state when the thread already exists", () => {
    expect(resolveChatTraceEnabled({ storedTraceEnabled: true, requestedTraceEnabled: false, admin: true })).toBe(true);
    expect(resolveChatTraceEnabled({ storedTraceEnabled: false, requestedTraceEnabled: true, admin: true })).toBe(
      false,
    );
  });

  it("honors pending new-thread trace capture for admins only", () => {
    expect(resolveChatTraceEnabled({ storedTraceEnabled: undefined, requestedTraceEnabled: true, admin: true })).toBe(
      true,
    );
    expect(resolveChatTraceEnabled({ storedTraceEnabled: undefined, requestedTraceEnabled: true, admin: false })).toBe(
      false,
    );
  });
});

describe("resolveRequestedReasoningEffort", () => {
  it("clamps stale or forged effort values for known OpenAI models", () => {
    expect(resolveRequestedReasoningEffort("openai", "gpt-5.6-sol", "minimal")).toBe("low");
    expect(resolveRequestedReasoningEffort("openai", "gpt-5", "none")).toBe("minimal");
    expect(resolveRequestedReasoningEffort("openai", "gpt-5-mini", "xhigh")).toBe("high");
    expect(resolveRequestedReasoningEffort("openai", "gpt-5-nano", "max")).toBe("high");
  });

  it("preserves supported values and defaults malformed input", () => {
    expect(resolveRequestedReasoningEffort("openai", "gpt-5.6-terra", "max")).toBe("max");
    expect(resolveRequestedReasoningEffort("openai", "gpt-5.6-luna", "none")).toBe("none");
    expect(resolveRequestedReasoningEffort("openai", "gpt-5.6-sol", "extreme")).toBe("medium");
  });
});

describe("modelOptionsForProvider", () => {
  it("disables OpenAI response storage while preserving the selected reasoning effort", () => {
    expect(modelOptionsForProvider("openai", "high")).toEqual({
      reasoning: { effort: "high" },
      store: false,
    });
  });

  it("does not add OpenAI-specific model options to Anthropic requests", () => {
    expect(modelOptionsForProvider("anthropic", "medium")).toBeUndefined();
  });
});

describe("opaque protection tickets", () => {
  it("preserves header-safe tickets from other engines without UUID assumptions", () => {
    for (const ticket of ["opaque", "token_from.another+engine/with=encoding", "a".repeat(256)]) {
      expect(cleanProtectionTicket(ticket)).toBe(ticket);
    }
    expect(cleanProtectionTicket(undefined)).toBeUndefined();
  });
  it("rejects malformed supplied tickets instead of silently sending without review", () => {
    for (const ticket of [null, 42, "", " token ", "token\r\ninjected: yes"]) {
      expect(() => cleanProtectionTicket(ticket)).toThrow("invalid protection ticket");
    }
  });
});

describe("stored thread protection", () => {
  it("negotiates preview capability and preserves the scoped client's opaque ticket", async () => {
    const protectionPreview = vi.fn().mockResolvedValue({ ticket: "opaque.other-engine/token" });
    vi.mocked(gatewayFictaControlClient).mockResolvedValueOnce({ protectionPreview } as unknown as FictaControlClient);
    await expect(prepareStoredThreadProtection("trusted-scope", "exact text", ["text"])).resolves.toBe(
      "opaque.other-engine/token",
    );
    expect(gatewayFictaControlClient).toHaveBeenLastCalledWith({
      requiredCapability: "protection-preview",
      headers: { "x-ficta-scope": "trusted-scope" },
    });
    expect(protectionPreview).toHaveBeenCalledWith({ text: "exact text", protectedValues: ["text"] });
  });
  it("stops when capability negotiation fails", async () => {
    vi.mocked(gatewayFictaControlClient).mockRejectedValueOnce(new Error("incompatible proxy"));
    await expect(prepareStoredThreadProtection("trusted-scope", "text", ["text"])).rejects.toThrow(
      "incompatible proxy",
    );
  });
});
