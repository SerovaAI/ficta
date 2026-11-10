import { describe, expect, it } from "vitest";
import { DOCUMENT_FENCE_INSTRUCTION } from "@/lib/documents/document-blocks";
import { deriveThreadTitleFromText } from "@/lib/thread-title";

const FILE_CONTEXT = [
  "Attached text file 1 (filename omitted for privacy, 12 characters):",
  "<file_content>",
  "Clause four.",
  "</file_content>",
].join("\n");

describe("deriveThreadTitleFromText", () => {
  it("titles an attachment turn from the user request", () => {
    expect(deriveThreadTitleFromText(`${FILE_CONTEXT}\n\nUser request:\nTighten clause 4`)).toBe("Tighten clause 4");
  });

  it("leaves the appended document-fence instruction out of the title", () => {
    const text = `${FILE_CONTEXT}\n\nUser request:\nTighten clause 4\n\n${DOCUMENT_FENCE_INSTRUCTION}`;
    expect(deriveThreadTitleFromText(text)).toBe("Tighten clause 4");
  });

  it("falls back to the attachment title when there is no request text", () => {
    const text = `Please review the attached text file content.\n\n${FILE_CONTEXT}\n\n${DOCUMENT_FENCE_INSTRUCTION}`;
    expect(deriveThreadTitleFromText(text)).toBe("Review Attached Text File");
  });
});
