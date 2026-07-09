import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";
import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { validateRestoredMessage, validateRestoredText } from "@/lib/restore-validation";

describe("validateRestoredText", () => {
  it("reports nothing for a clean, fully-restored response", () => {
    expect(validateRestoredText("Matter: NSB-2026-0147 for Northstar Biologics.").total).toBe(0);
  });

  it("flags a truncated surrogate the model shortened", () => {
    const result = validateRestoredText("Date shown only as FICTA_62a02923... placeholder");
    expect(result.truncated).toEqual(["FICTA_62a02923"]);
    expect(result.complete).toEqual([]);
    expect(result.total).toBe(1);
  });

  it("flags a complete surrogate that reached the user un-restored", () => {
    const token = "FICTA_e0ba46ccd8719363bd0443dea6de3a4d";
    const result = validateRestoredText(`Matter: ${token}`);
    expect(result.complete).toEqual([token]);
    expect(result.truncated).toEqual([]);
  });

  it("classifies a typed surrogate as complete", () => {
    const token = "FICTA_PERSON_1234567890abcdef1234567890abcdef";
    expect(validateRestoredText(`Client ${token}`).complete).toEqual([token]);
  });

  it("counts both kinds together", () => {
    const result = validateRestoredText("FICTA_62a02923... and FICTA_e0ba46ccd8719363bd0443dea6de3a4d");
    expect(result.truncated.length).toBe(1);
    expect(result.complete.length).toBe(1);
    expect(result.total).toBe(2);
  });
});

describe("validateRestoredMessage", () => {
  it("strips highlight markers first, so an in-marker surrogate is not a false positive", () => {
    const surrogate = "FICTA_e0ba46ccd8719363bd0443dea6de3a4d";
    const marked = `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_METADATA}NSB-2026-0147${FICTA_RESTORE_HIGHLIGHT_END}`;
    const message = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", content: `Matter: ${marked}` }],
    } as UIMessage;

    // The visible text is "Matter: NSB-2026-0147" — no residual surrogate.
    expect(validateRestoredMessage(message).total).toBe(0);
  });

  it("detects a truncated surrogate in the finished message text", () => {
    const message = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", content: "Date: FICTA_62a02923..." }],
    } as UIMessage;

    expect(validateRestoredMessage(message).truncated).toEqual(["FICTA_62a02923"]);
  });
});
