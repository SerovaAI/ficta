import { describe, expect, it } from "vitest";
import { canSubmitComposerDraft } from "../src/lib/composer-submit";

describe("canSubmitComposerDraft", () => {
  it("requires instructions or an attachment", () => {
    expect(canSubmitComposerDraft({ value: "", isLoading: false })).toBe(false);
    expect(canSubmitComposerDraft({ value: "   ", isLoading: false })).toBe(false);
    expect(canSubmitComposerDraft({ value: "", attachmentCount: 1, isLoading: false })).toBe(true);
    expect(canSubmitComposerDraft({ value: "   ", attachmentCount: 1, isLoading: false })).toBe(true);
    expect(canSubmitComposerDraft({ value: "summarize this", isLoading: false })).toBe(true);
    expect(canSubmitComposerDraft({ value: "summarize this", attachmentCount: 1, isLoading: false })).toBe(true);
  });

  it("blocks while the composer is busy or disabled", () => {
    expect(canSubmitComposerDraft({ value: "summarize this", isLoading: true })).toBe(false);
    expect(canSubmitComposerDraft({ value: "summarize this", isLoading: false, isExtracting: true })).toBe(false);
    expect(canSubmitComposerDraft({ value: "", attachmentCount: 1, isLoading: true })).toBe(false);
    expect(canSubmitComposerDraft({ value: "", attachmentCount: 1, isLoading: false, isExtracting: true })).toBe(false);
    expect(
      canSubmitComposerDraft({
        value: "summarize this",
        isLoading: false,
        disabledReason: "ficta isn't connected, so messages can't be sent yet.",
      }),
    ).toBe(false);
    expect(
      canSubmitComposerDraft({
        value: "",
        attachmentCount: 1,
        isLoading: false,
        disabledReason: "ficta isn't connected, so messages can't be sent yet.",
      }),
    ).toBe(false);
  });
});
