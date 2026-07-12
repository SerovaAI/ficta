import { describe, expect, it } from "vitest";
import { protectionReviewShortcut } from "@/components/chat/ProtectionReview";

describe("protection review shortcuts", () => {
  it("returns to editing on Escape", () => {
    expect(
      protectionReviewShortcut({ key: "Escape", metaKey: false, ctrlKey: false, defaultPrevented: false }, false),
    ).toBe("back");
  });

  it.each([
    { metaKey: true, ctrlKey: false },
    { metaKey: false, ctrlKey: true },
  ])("sends with the platform modifier and Enter", ({ metaKey, ctrlKey }) => {
    expect(protectionReviewShortcut({ key: "Enter", metaKey, ctrlKey, defaultPrevented: false }, false)).toBe("send");
  });

  it("does not act while busy or after another control handled the event", () => {
    const escapeEvent = { key: "Escape", metaKey: false, ctrlKey: false, defaultPrevented: false };
    expect(protectionReviewShortcut(escapeEvent, true)).toBeUndefined();
    expect(protectionReviewShortcut({ ...escapeEvent, defaultPrevented: true }, false)).toBeUndefined();
  });
});
