import { describe, expect, it } from "vitest";
import {
  PROTECTION_REVIEW_BATCH_MAX,
  pendingProtectionRanges,
  validatePendingProtection,
} from "../src/lib/protection-review-queue";

describe("validatePendingProtection", () => {
  const base = {
    originalText: "Send the Apollo brief to Jordan Price.",
    pendingValues: [] as string[],
    protectedValues: [] as string[],
  };

  it("normalizes a phrase that appears in the original message", () => {
    expect(validatePendingProtection({ ...base, value: "  Apollo  " })).toEqual({ ok: true, value: "Apollo" });
  });

  it.each([
    ["", "empty"],
    ["FICTA_SECRET_0123456789abcdef0123456789abcdef", "surrogate"],
    ["Missing", "absent"],
  ])("rejects %j as %s", (value, reason) => {
    expect(validatePendingProtection({ ...base, value })).toEqual({ ok: false, reason });
  });

  it("rejects pending and confirmed duplicates", () => {
    expect(validatePendingProtection({ ...base, value: "Apollo", pendingValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(validatePendingProtection({ ...base, value: "Apollo", protectedValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "protected",
    });
  });

  it("caps one batch at the protection-preview request limit", () => {
    const pendingValues = Array.from({ length: PROTECTION_REVIEW_BATCH_MAX }, (_, index) => `value-${index}`);
    expect(validatePendingProtection({ ...base, value: "Apollo", pendingValues })).toEqual({
      ok: false,
      reason: "limit",
    });
  });
});

describe("pendingProtectionRanges", () => {
  it("marks every non-overlapping occurrence of queued values", () => {
    expect(pendingProtectionRanges("Apollo and Apollo met Jordan", ["Apollo", "Jordan"], [])).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
      { start: 22, end: 28 },
    ]);
  });

  it("keeps confirmed ranges authoritative", () => {
    expect(pendingProtectionRanges("Apollo met Jordan", ["Apollo", "Apollo met"], [{ start: 0, end: 6 }])).toEqual([]);
  });
});
