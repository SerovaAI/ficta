import { describe, expect, it } from "vitest";
import {
  PROTECTION_REVIEW_ADD_COPY,
  PROTECTION_REVIEW_SCOPE_COPY,
  protectionReviewShortcut,
} from "@/components/chat/ProtectionReview";

describe("protection review scope", () => {
  it("distinguishes detected identity from manually protected business terms", () => {
    expect(PROTECTION_REVIEW_SCOPE_COPY).toContain("identity and attribution");
    expect(PROTECTION_REVIEW_SCOPE_COPY).toContain("not every confidential business term");
    expect(PROTECTION_REVIEW_ADD_COPY).toContain("amount");
    expect(PROTECTION_REVIEW_ADD_COPY).toContain("clause");
  });
});

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

  it("does not intercept the native copy shortcut", () => {
    expect(
      protectionReviewShortcut({ key: "c", metaKey: true, ctrlKey: false, defaultPrevented: false }, false),
    ).toBeUndefined();
    expect(
      protectionReviewShortcut({ key: "c", metaKey: false, ctrlKey: true, defaultPrevented: false }, false),
    ).toBeUndefined();
  });
});
