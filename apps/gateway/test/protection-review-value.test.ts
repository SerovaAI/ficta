import { describe, expect, it } from "vitest";
import { validateProtectionValue } from "../src/lib/protection-review-value";

describe("validateProtectionValue", () => {
  const base = {
    originalText: "Send the Apollo brief to Jordan Price.",
    protectedValues: [] as string[],
  };

  it("normalizes a phrase that appears in the original message", () => {
    expect(validateProtectionValue({ ...base, value: "  Apollo  " })).toEqual({ ok: true, value: "Apollo" });
  });

  it.each([
    ["", "empty"],
    ["FICTA_SECRET_0123456789abcdef0123456789abcdef", "surrogate"],
    ["Missing", "absent"],
  ])("rejects %j as %s", (value, reason) => {
    expect(validateProtectionValue({ ...base, value })).toEqual({ ok: false, reason });
  });

  it("rejects a value that is already protected", () => {
    expect(validateProtectionValue({ ...base, value: "Apollo", protectedValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "protected",
    });
  });
});
