import type { ProtectionPreviewFinding, ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import {
  automaticProtectionValues,
  normalizeHighlightedProtectionValue,
  protectionSelectionCandidate,
  validateProtectionValue,
} from "../src/lib/protection-review-value";

describe("normalizeHighlightedProtectionValue", () => {
  it.each([
    [" fraud, ", "fraud"],
    ['"fraud"', "fraud"],
    ["fraud, wilfully, ", "fraud, wilfully"],
    ['("fraud"),', "fraud"],
    ["[[fraud]].", "fraud"],
  ])("normalizes selection edges in %j", (selection, expected) => {
    expect(normalizeHighlightedProtectionValue(selection)).toBe(expected);
  });

  it.each(["O'Connor", "C++", "ACME-42", "user@example.com", "1,234.56", "§ 4.2"])(
    "preserves meaningful punctuation in %j",
    (selection) => {
      expect(normalizeHighlightedProtectionValue(selection)).toBe(selection);
    },
  );

  it.each(["", "  ", "!!!", '"..."'])("rejects selection %j when no substantive text remains", (selection) => {
    expect(normalizeHighlightedProtectionValue(selection)).toBe("");
  });
});

describe("validateProtectionValue", () => {
  const base = {
    originalText: "Send the Apollo brief to Jordan Price.",
    protectedValues: [] as string[],
  };

  it("trims a typed phrase without rewriting its punctuation", () => {
    expect(
      validateProtectionValue({
        originalText: "Review fraud, wilfully, before filing.",
        protectedValues: [],
        value: "  fraud, wilfully,  ",
      }),
    ).toEqual({ ok: true, value: "fraud, wilfully," });
  });

  it.each([
    ["", "empty"],
    ["FICTA_SECRET_0123456789abcdef0123456789abcdef", "surrogate"],
    ["Missing", "absent"],
  ])("rejects %j as %s", (value, reason) => {
    expect(validateProtectionValue({ ...base, value })).toEqual({ ok: false, reason });
  });

  it("classifies chat, registry, and detector coverage separately", () => {
    expect(validateProtectionValue({ ...base, value: "Apollo", protectedValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "protected-chat",
    });
    expect(validateProtectionValue({ ...base, value: "Apollo", registryValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "protected-registry",
    });
    expect(validateProtectionValue({ ...base, value: "Apollo", detectedValues: ["Apollo"] })).toEqual({
      ok: false,
      reason: "protected-detected",
    });
  });

  it("matches word-like values across case and ordinary whitespace reflow", () => {
    expect(
      validateProtectionValue({
        originalText: "Send PROJECT\nAPOLLO now.",
        protectedValues: ["Project Apollo"],
        value: "project\tApollo",
      }),
    ).toEqual({ ok: false, reason: "protected-chat" });
  });

  it("keeps digit-bearing opaque values case-sensitive", () => {
    expect(
      validateProtectionValue({
        originalText: "Compare TOKEN-A1 with token-a1.",
        protectedValues: ["TOKEN-A1"],
        value: "token-a1",
      }),
    ).toEqual({ ok: true, value: "token-a1" });
  });

  it("allows a removed value to be added again when only a stale user finding remains", () => {
    const text = "Review fraud before filing.";
    const automaticValues = automaticProtectionValues(text, [finding(text, "fraud", "user")]);
    expect(
      validateProtectionValue({ originalText: text, protectedValues: [], value: "fraud", ...automaticValues }),
    ).toEqual({ ok: true, value: "fraud" });
  });
});

describe("protectionSelectionCandidate", () => {
  const originalText = "Review fraud, wilfully, before sharing Project Apollo.";

  it("preserves exact clipboard text while normalizing the value used for protection", () => {
    expect(
      protectionSelectionCandidate({
        rawValue: " fraud, wilfully, ",
        originalText,
        protectedValues: [],
      }),
    ).toEqual({
      rawValue: " fraud, wilfully, ",
      protection: { ok: true, value: "fraud, wilfully" },
    });
  });

  it("keeps unprotectable selections available for copying", () => {
    expect(protectionSelectionCandidate({ rawValue: "!!!", originalText, protectedValues: [] })).toEqual({
      rawValue: "!!!",
      protection: { ok: false, reason: "empty" },
    });
    expect(
      protectionSelectionCandidate({
        rawValue: "Project Apollo",
        originalText,
        protectedValues: ["Project Apollo"],
      }),
    ).toEqual({
      rawValue: "Project Apollo",
      protection: { ok: false, reason: "protected-chat" },
    });
  });

  it("treats surrogate selections as copyable but already protected", () => {
    for (const surrogate of ["FICTA_SECRET_0123456789abcdef0123456789abcdef", "FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH"]) {
      expect(protectionSelectionCandidate({ rawValue: surrogate, originalText, protectedValues: [] })).toEqual({
        rawValue: surrogate,
        protection: { ok: false, reason: "surrogate" },
      });
    }
  });

  it("omits collapsed or whitespace-only selections", () => {
    expect(protectionSelectionCandidate({ rawValue: "  ", originalText, protectedValues: [] })).toBeUndefined();
  });
});

describe("automaticProtectionValues", () => {
  it("keeps registry and detector findings but excludes user findings", () => {
    const text = "Apollo met Jordan near Copper.";
    expect(
      automaticProtectionValues(text, [
        finding(text, "Apollo", "registry"),
        finding(text, "Jordan", "detected"),
        finding(text, "Copper", "user"),
      ]),
    ).toEqual({ registryValues: ["Apollo"], detectedValues: ["Jordan"] });
  });
});

function finding(text: string, value: string, origin: ProtectionPreviewOrigin): ProtectionPreviewFinding {
  const start = text.indexOf(value);
  return {
    name: `${origin}-fixture`,
    source: `${origin}-fixture`,
    start,
    end: start + value.length,
    surrogate: "FICTA_0123456789abcdef0123456789abcdef",
    origin,
  };
}
