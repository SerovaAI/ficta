import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_ORIGIN,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";
import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { protectionAnnotationsFromPart, withProtectionAnnotations } from "@/lib/restore-highlights";
import { createRestoreHighlightStore, deriveRestoreHighlightDisplay } from "@/lib/use-restore-highlight-display";

const SURROGATE = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
const MARKED = `${FICTA_RESTORE_HIGHLIGHT_START}${SURROGATE}${FICTA_RESTORE_HIGHLIGHT_ORIGIN}detected${FICTA_RESTORE_HIGHLIGHT_METADATA}jane.doe@example.com${FICTA_RESTORE_HIGHLIGHT_END}`;

function assistant(content: string, id = "assistant-1"): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", content }] } as UIMessage;
}

function user(content: string, id = "user-1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] } as UIMessage;
}

function partOf(message: UIMessage | undefined, partIndex: number): { content?: string } {
  return (message?.parts[partIndex] ?? {}) as { content?: string };
}

function annotationsOf(message: UIMessage | undefined, partIndex = 0) {
  return protectionAnnotationsFromPart(message?.parts[partIndex]);
}

describe("deriveRestoreHighlightDisplay", () => {
  it("parses a streaming marker part into visible text + restorations and caches it", () => {
    const store = createRestoreHighlightStore();
    const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(
      [user("hi"), assistant(`Email: ${MARKED}`)],
      store,
    );

    expect(partOf(displayMessages[1], 0).content).toBe("Email: jane.doe@example.com");
    expect(annotationsOf(displayMessages[1])).toEqual([
      { start: 7, end: 27, surrogate: SURROGATE, origin: "detected", direction: "restored" },
    ]);
    expect(restoreHighlightsAvailable).toBe(true);
    expect(store.get(1)?.get(0)).toEqual([{ value: "jane.doe@example.com", surrogate: SURROGATE, origin: "detected" }]);
  });

  it("re-attaches highlights to a finished marker-free message whose text has DRIFTED", () => {
    // The core regression: the finished text differs from the streamed text (here, a trailing newline),
    // which broke the old exact-equality cache. Value-occurrence re-anchoring survives it.
    const store = createRestoreHighlightStore();
    deriveRestoreHighlightDisplay([user("hi"), assistant(`Email: ${MARKED}`)], store);

    const finished = [user("hi"), assistant("Email: jane.doe@example.com\n")];
    const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(finished, store);

    expect(annotationsOf(displayMessages[1])).toEqual([
      { start: 7, end: 27, surrogate: SURROGATE, origin: "detected", direction: "restored" },
    ]);
    expect(partOf(displayMessages[1], 0).content).toBe("Email: jane.doe@example.com\n");
    expect(restoreHighlightsAvailable).toBe(true);
  });

  it("preserves highlights when the finished message arrives with a new id (position key)", () => {
    const store = createRestoreHighlightStore();
    deriveRestoreHighlightDisplay([user("hi"), assistant(`Email: ${MARKED}`, "streaming-id")], store);

    const finished = [user("hi"), assistant("Email: jane.doe@example.com", "final-id")];
    const { displayMessages } = deriveRestoreHighlightDisplay(finished, store);

    expect(annotationsOf(displayMessages[1])).toEqual([
      { start: 7, end: 27, surrogate: SURROGATE, origin: "detected", direction: "restored" },
    ]);
  });

  it("does not highlight when the value no longer appears (regenerated content)", () => {
    const store = createRestoreHighlightStore();
    deriveRestoreHighlightDisplay([user("hi"), assistant(`Email: ${MARKED}`)], store);

    const regenerated = [user("hi"), assistant("No email on file.")];
    const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(regenerated, store);

    expect(annotationsOf(displayMessages[1])).toEqual([]);
    expect(restoreHighlightsAvailable).toBe(false);
  });

  it("ignores user messages entirely", () => {
    const store = createRestoreHighlightStore();
    const messages = [user("hi"), assistant("plain reply")];
    const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(messages, store);

    expect(displayMessages).toBe(messages); // no assistant highlights → same reference back
    expect(restoreHighlightsAvailable).toBe(false);
  });

  it("hydrates persisted user and assistant annotations without a value-bearing cache", () => {
    const userMessage = user("Email jane.doe@example.com");
    userMessage.parts[0] = withProtectionAnnotations(userMessage.parts[0], [
      { start: 6, end: 26, surrogate: SURROGATE, origin: "detected", direction: "redacted" },
    ]);
    const assistantMessage = assistant("Confirmed jane.doe@example.com");
    assistantMessage.parts[0] = withProtectionAnnotations(assistantMessage.parts[0], [
      { start: 10, end: 30, surrogate: SURROGATE, origin: "detected", direction: "restored" },
    ]);

    const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(
      [userMessage, assistantMessage],
      createRestoreHighlightStore(),
    );

    expect(displayMessages).toEqual([userMessage, assistantMessage]);
    expect(restoreHighlightsAvailable).toBe(true);
  });

  it("prunes cache entries for turns that are no longer present", () => {
    const store = createRestoreHighlightStore();
    deriveRestoreHighlightDisplay([user("hi"), assistant(`Email: ${MARKED}`)], store);
    expect(store.has(1)).toBe(true);

    // A shorter transcript (e.g. after a reset) should evict the stale position.
    deriveRestoreHighlightDisplay([user("hi")], store);
    expect(store.has(1)).toBe(false);
  });
});
