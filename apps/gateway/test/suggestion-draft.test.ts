import { describe, expect, it } from "vitest";
import { draftWithSuggestion } from "@/components/chat/suggestionDraft";

describe("suggestion draft formatting", () => {
  it("adds a continuation line after a suggestion in an empty draft", () => {
    expect(draftWithSuggestion("", "Rewrite this in plain, clear language.")).toBe(
      "Rewrite this in plain, clear language.\n",
    );
  });

  it("appends a suggestion below an existing draft", () => {
    expect(draftWithSuggestion("Here is the source text.", "Summarize this document.")).toBe(
      "Here is the source text.\n\nSummarize this document.\n",
    );
  });

  it("trims trailing whitespace before appending a suggestion", () => {
    expect(draftWithSuggestion("Here is the source text.  \n\n", "Summarize this document.")).toBe(
      "Here is the source text.\n\nSummarize this document.\n",
    );
  });
});
