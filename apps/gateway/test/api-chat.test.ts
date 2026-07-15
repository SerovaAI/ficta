import { describe, expect, it } from "vitest";
import {
  latestUserText,
  messagesForModel,
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
