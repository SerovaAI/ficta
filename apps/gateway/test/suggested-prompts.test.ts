import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUGGESTED_PROMPTS,
  normalizeSuggestedPrompts,
  resolveSuggestedPrompts,
  SUGGESTED_PROMPT_MAX,
  SUGGESTED_PROMPTS_MAX,
} from "@/lib/storage/types";

describe("suggested prompts", () => {
  it("uses defaults when the instance setting is unset", () => {
    expect(resolveSuggestedPrompts({})).toEqual(DEFAULT_SUGGESTED_PROMPTS);
  });

  it("honors an empty saved list as no suggestions", () => {
    expect(resolveSuggestedPrompts({ suggestedPrompts: [] })).toEqual([]);
  });

  it("returns custom prompts in order", () => {
    expect(resolveSuggestedPrompts({ suggestedPrompts: ["First", "Second"] })).toEqual(["First", "Second"]);
  });

  it("normalizes prompt input before persistence", () => {
    const longPrompt = "x".repeat(SUGGESTED_PROMPT_MAX + 10);
    const input = [
      "  Keep this  ",
      "",
      "   ",
      42,
      longPrompt,
      ...Array.from({ length: SUGGESTED_PROMPTS_MAX + 2 }, (_, i) => `Extra ${i}`),
    ];

    const normalized = normalizeSuggestedPrompts(input);

    expect(normalized).toHaveLength(SUGGESTED_PROMPTS_MAX);
    expect(normalized[0]).toBe("Keep this");
    expect(normalized[1]).toBe("x".repeat(SUGGESTED_PROMPT_MAX));
    expect(normalized).not.toContain("");
  });
});
