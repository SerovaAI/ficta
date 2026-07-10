import { describe, expect, it } from "vitest";
import { latestUserText, requiresProtectionReviewTicket, resolveChatTraceEnabled } from "@/routes/api/chat";

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

describe("requiresProtectionReviewTicket", () => {
  it("fails closed when an administrator requires review", () => {
    expect(requiresProtectionReviewTicket({ protectionReviewRequired: true }, undefined)).toBe(true);
    expect(requiresProtectionReviewTicket({ protectionReviewRequired: true }, "ticket")).toBe(false);
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
