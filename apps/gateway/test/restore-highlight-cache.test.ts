import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";
import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { createRestoreHighlightCache, messagesWithCachedRestoreHighlights } from "@/lib/restore-highlight-cache";

describe("restore highlight display cache", () => {
  it("caches marker-bearing streamed text", () => {
    const cache = createRestoreHighlightCache();
    const marked = markedValue("FICTA_EMAIL_1234567890abcdef1234567890abcdef", "jane.doe@example.com");
    const messages = [assistantMessage([{ type: "text", content: `Email: ${marked}` }])];

    const display = messagesWithCachedRestoreHighlights(messages, cache);

    expect(display).toBe(messages);
    expect(cache.byMessageId.get("assistant-1")?.get(0)).toBe(`Email: ${marked}`);
    expect(cache.byPosition.get(0)?.get(0)).toBe(`Email: ${marked}`);
  });

  it("preserves marker-bearing text when the finished message is marker-stripped", () => {
    const cache = createRestoreHighlightCache();
    const marked = markedValue("FICTA_EMAIL_1234567890abcdef1234567890abcdef", "jane.doe@example.com");
    messagesWithCachedRestoreHighlights([assistantMessage([{ type: "text", content: `Email: ${marked}` }])], cache);

    const finalMessages = [assistantMessage([{ type: "text", content: "Email: jane.doe@example.com" }])];
    const display = messagesWithCachedRestoreHighlights(finalMessages, cache);

    expect(display).not.toBe(finalMessages);
    expect(textContent(display[0], 0)).toBe(`Email: ${marked}`);
    expect(textContent(finalMessages[0], 0)).toBe("Email: jane.doe@example.com");
  });

  it("preserves marker-bearing text when the finished message has a new id", () => {
    const cache = createRestoreHighlightCache();
    const marked = markedValue("FICTA_EMAIL_1234567890abcdef1234567890abcdef", "jane.doe@example.com");
    messagesWithCachedRestoreHighlights(
      [assistantMessage([{ type: "text", content: `Email: ${marked}` }], "streaming-id")],
      cache,
    );

    const finalMessages = [assistantMessage([{ type: "text", content: "Email: jane.doe@example.com" }], "final-id")];
    const display = messagesWithCachedRestoreHighlights(finalMessages, cache);

    expect(textContent(display[0], 0)).toBe(`Email: ${marked}`);
  });

  it("does not reuse stale markers when final text differs", () => {
    const cache = createRestoreHighlightCache();
    const marked = markedValue("FICTA_EMAIL_1234567890abcdef1234567890abcdef", "jane.doe@example.com");
    messagesWithCachedRestoreHighlights([assistantMessage([{ type: "text", content: `Email: ${marked}` }])], cache);

    const changedMessages = [assistantMessage([{ type: "text", content: "Email: jane@example.test" }])];
    const display = messagesWithCachedRestoreHighlights(changedMessages, cache);

    expect(display).toBe(changedMessages);
    expect(textContent(display[0], 0)).toBe("Email: jane@example.test");
    expect(cache.byMessageId.has("assistant-1")).toBe(false);
    expect(cache.byPosition.has(0)).toBe(false);
  });

  it("handles multiple text parts independently", () => {
    const cache = createRestoreHighlightCache();
    const firstMarked = markedValue("FICTA_PERSON_1234567890abcdef1234567890abcdef", "Jane Doe");
    const secondMarked = markedValue("FICTA_EMAIL_abcdef1234567890abcdef1234567890", "jane.doe@example.com");
    messagesWithCachedRestoreHighlights(
      [
        assistantMessage([
          { type: "text", content: `Client: ${firstMarked}` },
          { type: "tool-call", id: "tool-1", name: "lookup", state: "done" },
          { type: "text", content: `Email: ${secondMarked}` },
        ]),
      ],
      cache,
    );

    const display = messagesWithCachedRestoreHighlights(
      [
        assistantMessage([
          { type: "text", content: "Client: Jane Doe" },
          { type: "tool-call", id: "tool-1", name: "lookup", state: "done" },
          { type: "text", content: "Email: jane.doe@example.com" },
        ]),
      ],
      cache,
    );

    expect(textContent(display[0], 0)).toBe(`Client: ${firstMarked}`);
    expect(textContent(display[0], 2)).toBe(`Email: ${secondMarked}`);
  });
});

function markedValue(surrogate: string, value: string): string {
  return `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_METADATA}${value}${FICTA_RESTORE_HIGHLIGHT_END}`;
}

function assistantMessage(parts: Array<Record<string, unknown>>, id = "assistant-1"): UIMessage {
  return {
    id,
    role: "assistant",
    parts: parts as UIMessage["parts"],
  };
}

function textContent(message: UIMessage | undefined, partIndex: number): string | undefined {
  return (message?.parts[partIndex] as { content?: string } | undefined)?.content;
}
