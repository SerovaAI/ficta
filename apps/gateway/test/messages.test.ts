import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_ORIGIN,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";
import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { storedToUi, uiToStored } from "@/lib/storage/messages";

// The mappers are the glue between the live chat client (UIMessage, createdAt: Date) and the persisted
// form (StoredMessage, createdAt: ISO string). This covers the client-side conversion that the streaming
// save/hydrate path relies on but which can't be exercised without a live model call.
describe("message mapping", () => {
  it("round-trips a UIMessage through storage form", () => {
    const created = new Date("2026-07-02T08:00:00.000Z");
    const ui: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      createdAt: created,
    };

    const stored = uiToStored(ui);
    expect(stored).toEqual({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      createdAt: "2026-07-02T08:00:00.000Z",
    });

    const back = storedToUi(stored);
    expect(back.id).toBe("m1");
    expect(back.role).toBe("assistant");
    expect(back.parts).toEqual(ui.parts);
    expect(back.createdAt?.toISOString()).toBe(created.toISOString());
  });

  it("tolerates a message without a timestamp", () => {
    const stored = uiToStored({ id: "x", role: "user", parts: [] });
    expect(stored.createdAt).toBeUndefined();
    expect(storedToUi(stored).createdAt).toBeUndefined();
  });

  it("strips restore highlight markers before storage", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const marked = `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_ORIGIN}detected${FICTA_RESTORE_HIGHLIGHT_METADATA}jane.doe@example.com${FICTA_RESTORE_HIGHLIGHT_END}`;
    const stored = uiToStored({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", content: `Email: ${marked}` }] as UIMessage["parts"],
    });

    expect(stored.parts).toEqual([{ type: "text", content: "Email: jane.doe@example.com" }]);
  });

  it("round-trips namespaced protection annotations through stored history", () => {
    const annotation = {
      start: 7,
      end: 27,
      surrogate: "FICTA_EMAIL_1234567890abcdef1234567890abcdef",
      origin: "detected",
      direction: "restored",
    };
    const stored = uiToStored({
      id: "m3",
      role: "assistant",
      parts: [
        {
          type: "text",
          content: "Email: jane.doe@example.com",
          metadata: { fictaProtection: [annotation] },
        },
      ] as UIMessage["parts"],
    });

    expect(storedToUi(stored).parts).toEqual(stored.parts);
    expect(stored.parts[0]?.metadata?.fictaProtection).toEqual([annotation]);
  });
});
