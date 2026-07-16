import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { assistantResponseClipboardText } from "@/lib/message-copy";
import { withProtectionAnnotations } from "@/lib/restore-highlights";

const SURROGATE = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";

function assistant(parts: UIMessage["parts"]): UIMessage {
  return { id: "assistant-1", role: "assistant", parts } as UIMessage;
}

describe("assistantResponseClipboardText", () => {
  it("preserves Markdown across every text part and excludes non-answer parts", () => {
    const message = assistant([
      { type: "text", content: "## Result\n\n- first\n\n" },
      { type: "thinking", content: "hidden chain of thought" },
      {
        type: "tool-call",
        id: "tool-1",
        name: "lookup",
        state: "complete",
        arguments: {},
      },
      { type: "text", content: "```ts\nconst answer = 42;\n```" },
    ] as UIMessage["parts"]);

    expect(assistantResponseClipboardText(message, "values")).toBe(
      "## Result\n\n- first\n\n```ts\nconst answer = 42;\n```",
    );
  });

  it("copies the restored value or its surrogate according to the active display mode", () => {
    const content = "Email: jane.doe@example.com";
    const part = withProtectionAnnotations({ type: "text" as const, content }, [
      {
        start: 7,
        end: 27,
        surrogate: SURROGATE,
        origin: "detected",
        direction: "restored",
      },
    ]);
    const message = assistant([part]);

    expect(assistantResponseClipboardText(message, "values")).toBe(content);
    expect(assistantResponseClipboardText(message, "surrogates")).toBe(`Email: ${SURROGATE}`);
  });

  it("returns an empty string when the response has no answer text", () => {
    const message = assistant([{ type: "thinking", content: "still hidden" }] as UIMessage["parts"]);

    expect(assistantResponseClipboardText(message, "values")).toBe("");
  });
});
