import { describe, expect, it } from "vitest";
import { restoreConfirmationMessage, validateThreadReason } from "@/lib/storage/records-validation";

describe("records access validation", () => {
  it("accepts a restricted ticket reference and trims the payload", () => {
    expect(
      validateThreadReason({
        threadId: " retained-thread ",
        reason: { reference: " INC-2026/1042 " },
      }),
    ).toEqual({
      threadId: "retained-thread",
      reason: { reference: "INC-2026/1042" },
    });
  });

  it("allows omitting the reference entirely", () => {
    expect(validateThreadReason({ threadId: "thread", reason: {} })).toEqual({ threadId: "thread", reason: {} });
  });

  it("rejects free-form details in the reference", () => {
    expect(() =>
      validateThreadReason({
        threadId: "thread",
        reason: { reference: "Client Smith matter" },
      }),
    ).toThrow("Reference may contain only");
  });

  it("makes restoration to the original owner an explicit confirmation", () => {
    expect(restoreConfirmationMessage("user_01ABC")).toBe(
      "Restore this chat to its original owner (user_01ABC)? The restore will be recorded separately.",
    );
  });
});
