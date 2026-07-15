import { describe, expect, it } from "vitest";
import { validateInstancePatch } from "@/lib/storage/settings";

describe("instance settings validation", () => {
  it("accepts every protection review minimum", () => {
    expect(validateInstancePatch({ protectionReviewMinimum: "off" })).toEqual({ protectionReviewMinimum: "off" });
    expect(validateInstancePatch({ protectionReviewMinimum: "adaptive" })).toEqual({
      protectionReviewMinimum: "adaptive",
    });
    expect(validateInstancePatch({ protectionReviewMinimum: "always" })).toEqual({
      protectionReviewMinimum: "always",
    });
  });

  it("rejects unsupported protection review minimums", () => {
    expect(() => validateInstancePatch({ protectionReviewMinimum: "required" })).toThrow(
      "invalid protectionReviewMinimum",
    );
    expect(() => validateInstancePatch({ protectionReviewMinimum: true })).toThrow("invalid protectionReviewMinimum");
  });
});
