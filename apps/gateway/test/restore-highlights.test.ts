import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
} from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import {
  hasVisibleRestorations,
  parseRestoreHighlightText,
  renderVisibleHighlights,
  stripRestoreHighlightMarkers,
} from "@/lib/restore-highlights";

function marked(surrogate: string, value: string): string {
  return `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_METADATA}${value}${FICTA_RESTORE_HIGHLIGHT_END}`;
}

describe("parseRestoreHighlightText", () => {
  it("splits marker-bearing text into clean visible text and structured restorations", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const { visibleText, restorations } = parseRestoreHighlightText(
      `Email: ${marked(surrogate, "jane.doe@example.com")}.`,
    );

    expect(visibleText).toBe("Email: jane.doe@example.com.");
    expect(restorations).toEqual([{ value: "jane.doe@example.com", surrogate }]);
  });

  it("parses an old-format marker without surrogate metadata", () => {
    const { visibleText, restorations } = parseRestoreHighlightText(
      `The client is ${FICTA_RESTORE_HIGHLIGHT_START}Jane & <Doe>${FICTA_RESTORE_HIGHLIGHT_END}.`,
    );

    expect(visibleText).toBe("The client is Jane & <Doe>.");
    expect(restorations).toEqual([{ value: "Jane & <Doe>", surrogate: undefined }]);
  });

  it("de-duplicates a value repeated within one turn", () => {
    const surrogate = "FICTA_PERSON_1234567890abcdef1234567890abcdef";
    const { visibleText, restorations } = parseRestoreHighlightText(
      `${marked(surrogate, "Jane Doe")} and again ${marked(surrogate, "Jane Doe")}`,
    );

    expect(visibleText).toBe("Jane Doe and again Jane Doe");
    expect(restorations).toEqual([{ value: "Jane Doe", surrogate }]);
  });

  it("hides a trailing partial marker while a stream chunk is incomplete", () => {
    const { visibleText, restorations } = parseRestoreHighlightText(
      `Contact ${FICTA_RESTORE_HIGHLIGHT_START.slice(0, 4)}`,
    );
    expect(visibleText).toBe("Contact ");
    expect(restorations).toEqual([]);
  });

  it("hides incomplete surrogate metadata and yields no restoration yet", () => {
    const { visibleText, restorations } = parseRestoreHighlightText(`${FICTA_RESTORE_HIGHLIGHT_START}FICTA_EMAIL_123`);
    expect(visibleText).toBe("");
    expect(restorations).toEqual([]);
  });
});

describe("renderVisibleHighlights", () => {
  it("wraps the restored value in a safe custom tag by default", () => {
    const result = renderVisibleHighlights("The client is Jane & <Doe>.", [{ value: "Jane & <Doe>" }]);
    expect(result.highlighted).toBe(true);
    expect(result.html).toBe("The client is <ficta-restore>Jane &amp; &lt;Doe&gt;</ficta-restore>.");
  });

  it("shows the surrogate token when the privacy display is toggled", () => {
    const surrogate = "FICTA_PERSON_1234567890abcdef1234567890abcdef";
    const restorations = [{ value: "Jane Doe", surrogate }];
    expect(renderVisibleHighlights("The client is Jane Doe.", restorations, "surrogates").html).toBe(
      `The client is <ficta-restore>${surrogate}</ficta-restore>.`,
    );
  });

  it("highlights every occurrence of a repeated value", () => {
    const result = renderVisibleHighlights("X then X", [{ value: "X" }]);
    expect(result.html).toBe("<ficta-restore>X</ficta-restore> then <ficta-restore>X</ficta-restore>");
  });

  it("prefers the longest value so it never double-wraps a nested substring", () => {
    const result = renderVisibleHighlights("Jane Doe", [{ value: "Jane" }, { value: "Jane Doe" }]);
    expect(result.html).toBe("<ficta-restore>Jane Doe</ficta-restore>");
  });

  it("is a no-op when the value is absent (drift / regenerated content)", () => {
    const result = renderVisibleHighlights("Nothing to see here", [{ value: "jane.doe@example.com" }]);
    expect(result.highlighted).toBe(false);
    expect(result.html).toBe("Nothing to see here");
  });
});

describe("hasVisibleRestorations", () => {
  it("is true only when a restoration value appears in the text", () => {
    expect(hasVisibleRestorations("Email: jane.doe@example.com", [{ value: "jane.doe@example.com" }])).toBe(true);
    expect(hasVisibleRestorations("Email redacted", [{ value: "jane.doe@example.com" }])).toBe(false);
  });
});

describe("stripRestoreHighlightMarkers", () => {
  it("strips markers recursively before storage or model replay", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const message = { parts: [{ type: "text", content: `Email: ${marked(surrogate, "jane.doe@example.com")}` }] };

    expect(stripRestoreHighlightMarkers(message)).toEqual({
      parts: [{ type: "text", content: "Email: jane.doe@example.com" }],
    });
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
