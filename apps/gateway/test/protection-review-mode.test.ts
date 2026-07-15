import { describe, expect, it } from "vitest";
import {
  effectiveProtectionReviewMode,
  isProtectionReviewMode,
  protectionPreviewOutcome,
  protectionReviewModeAllowed,
  protectionReviewRequiresPreview,
} from "@/lib/protection-review-mode";

describe("protection review modes", () => {
  it("uses the stricter of the chat selection and administrator minimum", () => {
    expect(effectiveProtectionReviewMode("off", "adaptive")).toBe("adaptive");
    expect(effectiveProtectionReviewMode("adaptive", "always")).toBe("always");
    expect(effectiveProtectionReviewMode("always", "off")).toBe("always");
    expect(protectionReviewModeAllowed("off", "adaptive")).toBe(false);
    expect(protectionReviewModeAllowed("always", "adaptive")).toBe(true);
  });

  it("requires preview for Adaptive and Always only", () => {
    expect(protectionReviewRequiresPreview("off")).toBe(false);
    expect(protectionReviewRequiresPreview("adaptive")).toBe(true);
    expect(protectionReviewRequiresPreview("always")).toBe(true);
  });

  it("auto-sends only the finding-free Adaptive path", () => {
    expect(protectionPreviewOutcome("adaptive", 0)).toBe("send");
    expect(protectionPreviewOutcome("adaptive", 1)).toBe("review");
    expect(protectionPreviewOutcome("always", 0)).toBe("review");
    expect(protectionPreviewOutcome("always", 3)).toBe("review");
  });

  it("validates only supported setting values", () => {
    expect(isProtectionReviewMode("off")).toBe(true);
    expect(isProtectionReviewMode("adaptive")).toBe(true);
    expect(isProtectionReviewMode("always")).toBe(true);
    expect(isProtectionReviewMode("required")).toBe(false);
    expect(isProtectionReviewMode(true)).toBe(false);
  });
});
