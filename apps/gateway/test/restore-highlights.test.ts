import { FICTA_RESTORE_HIGHLIGHT_END, FICTA_RESTORE_HIGHLIGHT_START } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { restoreHighlightsToHtml, stripRestoreHighlightMarkers } from "@/lib/restore-highlights";

describe("restore highlight markers", () => {
  it("renders restored spans as a safe custom tag", () => {
    const marked = `The client is ${FICTA_RESTORE_HIGHLIGHT_START}Jane & <Doe>${FICTA_RESTORE_HIGHLIGHT_END}.`;

    expect(restoreHighlightsToHtml(marked)).toBe(
      "The client is <ficta-restore>Jane &amp; &lt;Doe&gt;</ficta-restore>.",
    );
  });

  it("strips markers recursively before storage or model replay", () => {
    const marked = `${FICTA_RESTORE_HIGHLIGHT_START}jane.doe@example.com${FICTA_RESTORE_HIGHLIGHT_END}`;

    expect(stripRestoreHighlightMarkers({ parts: [{ type: "text", content: `Email: ${marked}` }] })).toEqual({
      parts: [{ type: "text", content: "Email: jane.doe@example.com" }],
    });
  });

  it("hides a trailing partial marker while a stream chunk is incomplete", () => {
    expect(restoreHighlightsToHtml(`Contact ${FICTA_RESTORE_HIGHLIGHT_START.slice(0, 4)}`)).toBe("Contact ");
  });

  it("returns the original graph unchanged (no clone) when there are no markers", () => {
    // Normal (non-trace) traffic never carries markers, so the strip must not deep-clone: it should
    // hand back the exact same object/array references it was given.
    const parts = [{ type: "text", content: "Email: jane.doe@example.com" }];
    const message = { parts };
    const result = stripRestoreHighlightMarkers(message);

    expect(result).toBe(message);
    expect(result.parts).toBe(parts);
  });
});
