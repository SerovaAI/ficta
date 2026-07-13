import {
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_ORIGIN,
  FICTA_RESTORE_HIGHLIGHT_START,
  type ProtectionPreviewOrigin,
} from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { restoreHighlightPresentation } from "@/components/chat/Markdown";
import {
  hasVisibleRestorations,
  normalizeProtectionAnnotations,
  parseRestoreHighlightText,
  previewFindingsToAnnotations,
  protectionAnnotationsFromPart,
  protectionTextSegments,
  renderVisibleHighlights,
  stripProtectionDisplayMetadata,
  stripRestoreHighlightMarkers,
  withProtectionAnnotations,
} from "@/lib/restore-highlights";

function marked(surrogate: string, value: string, origin: ProtectionPreviewOrigin): string {
  return `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_ORIGIN}${origin}${FICTA_RESTORE_HIGHLIGHT_METADATA}${value}${FICTA_RESTORE_HIGHLIGHT_END}`;
}

describe("parseRestoreHighlightText", () => {
  it("splits marker-bearing text into clean visible text and structured restorations", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const { visibleText, restorations } = parseRestoreHighlightText(
      `Email: ${marked(surrogate, "jane.doe@example.com", "detected")}.`,
    );

    expect(visibleText).toBe("Email: jane.doe@example.com.");
    expect(restorations).toEqual([{ value: "jane.doe@example.com", surrogate, origin: "detected" }]);
  });

  it("suppresses marker payloads that do not use the current origin-bearing format", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const previous = `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_METADATA}jane.doe@example.com${FICTA_RESTORE_HIGHLIGHT_END}`;
    const oldest = `${FICTA_RESTORE_HIGHLIGHT_START}Jane Doe${FICTA_RESTORE_HIGHLIGHT_END}`;
    expect(parseRestoreHighlightText(`Before ${previous} after`)).toEqual({
      visibleText: "Before  after",
      restorations: [],
    });
    expect(parseRestoreHighlightText(`Before ${oldest} after`)).toEqual({
      visibleText: "Before  after",
      restorations: [],
    });
  });

  it("de-duplicates a value repeated within one turn", () => {
    const surrogate = "FICTA_PERSON_1234567890abcdef1234567890abcdef";
    const { visibleText, restorations } = parseRestoreHighlightText(
      `${marked(surrogate, "Jane Doe", "registry")} and again ${marked(surrogate, "Jane Doe", "registry")}`,
    );

    expect(visibleText).toBe("Jane Doe and again Jane Doe");
    expect(restorations).toEqual([{ value: "Jane Doe", surrogate, origin: "registry" }]);
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

  it("hides partial origin metadata at every streamed prefix", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const prefix = `${FICTA_RESTORE_HIGHLIGHT_START}${surrogate}${FICTA_RESTORE_HIGHLIGHT_ORIGIN}`;
    for (const originPrefix of ["", "d", "dete", "detected"]) {
      expect(parseRestoreHighlightText(`${prefix}${originPrefix}`)).toEqual({ visibleText: "", restorations: [] });
    }
  });
});

describe("renderVisibleHighlights", () => {
  it("wraps the restored value in a safe custom tag by default", () => {
    const result = renderVisibleHighlights("The client is Jane & <Doe>.", [
      { value: "Jane & <Doe>", surrogate: "FICTA_PERSON_1234567890abcdef1234567890abcdef", origin: "registry" },
    ]);
    expect(result.highlighted).toBe(true);
    expect(result.html).toBe(
      "The client is <ficta-protection-restored-registry>Jane &amp; &lt;Doe&gt;</ficta-protection-restored-registry>.",
    );
  });

  it("shows the surrogate token when the privacy display is toggled", () => {
    const surrogate = "FICTA_PERSON_1234567890abcdef1234567890abcdef";
    const restorations = [{ value: "Jane Doe", surrogate, origin: "detected" as const }];
    expect(renderVisibleHighlights("The client is Jane Doe.", restorations, "surrogates").html).toBe(
      `The client is <ficta-protection-restored-detected>${surrogate}</ficta-protection-restored-detected>.`,
    );
  });

  it("uses origin-specific tags for the three-way underline key", () => {
    const result = renderVisibleHighlights("Registry, detected, user", [
      { value: "Registry", surrogate: "FICTA_00000000000000000000000000000001", origin: "registry" },
      { value: "detected", surrogate: "FICTA_00000000000000000000000000000002", origin: "detected" },
      { value: "user", surrogate: "FICTA_00000000000000000000000000000003", origin: "user" },
    ]);
    expect(result.html).toBe(
      "<ficta-protection-restored-registry>Registry</ficta-protection-restored-registry>, " +
        "<ficta-protection-restored-detected>detected</ficta-protection-restored-detected>, " +
        "<ficta-protection-restored-user>user</ficta-protection-restored-user>",
    );
  });

  it("highlights every occurrence of a repeated value", () => {
    const result = renderVisibleHighlights("X then X", [
      { value: "X", surrogate: "FICTA_00000000000000000000000000000001", origin: "registry" },
    ]);
    expect(result.html).toBe(
      "<ficta-protection-restored-registry>X</ficta-protection-restored-registry> then " +
        "<ficta-protection-restored-registry>X</ficta-protection-restored-registry>",
    );
  });

  it("prefers the longest value so it never double-wraps a nested substring", () => {
    const result = renderVisibleHighlights("Jane Doe", [
      { value: "Jane", surrogate: "FICTA_00000000000000000000000000000001", origin: "detected" },
      { value: "Jane Doe", surrogate: "FICTA_00000000000000000000000000000002", origin: "registry" },
    ]);
    expect(result.html).toBe("<ficta-protection-restored-registry>Jane Doe</ficta-protection-restored-registry>");
  });

  it("is a no-op when the value is absent (drift / regenerated content)", () => {
    const result = renderVisibleHighlights("Nothing to see here", [
      {
        value: "jane.doe@example.com",
        surrogate: "FICTA_00000000000000000000000000000001",
        origin: "detected",
      },
    ]);
    expect(result.highlighted).toBe(false);
    expect(result.html).toBe("Nothing to see here");
  });
});

describe("durable protection annotations", () => {
  const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";

  it("stores only coordinates, origin, direction, and surrogate from preview findings", () => {
    const text = "Email jane.doe@example.com";
    expect(
      previewFindingsToAnnotations(text, [
        {
          start: 6,
          end: 26,
          surrogate,
          origin: "detected",
          name: "EMAIL",
          source: "sidecar",
          kind: "pii",
          confidence: "high",
        },
      ]),
    ).toEqual([{ start: 6, end: 26, surrogate, origin: "detected", direction: "redacted" }]);
  });

  it("rejects malformed, out-of-range, and overlapping hydrated evidence", () => {
    const text = "Jane Doe";
    expect(
      normalizeProtectionAnnotations(text, [
        { start: 0, end: 99, surrogate, origin: "detected", direction: "redacted" },
        { start: 0, end: 8, surrogate, origin: "registry", direction: "redacted" },
        { start: 2, end: 6, surrogate, origin: "detected", direction: "redacted" },
        { start: 8, end: 8, surrogate, origin: "user", direction: "redacted" },
      ]),
    ).toEqual([{ start: 0, end: 8, surrogate, origin: "registry", direction: "redacted" }]);
  });

  it("round-trips annotations through namespaced text metadata and model-view segments", () => {
    const text = "Email jane.doe@example.com";
    const part = withProtectionAnnotations({ type: "text", content: text, metadata: { provider: "keep" } }, [
      { start: 6, end: 26, surrogate, origin: "detected", direction: "redacted" },
    ]);

    const annotations = protectionAnnotationsFromPart(part);
    expect(annotations).toHaveLength(1);
    expect(protectionAnnotationsFromPart(part, "restored")).toEqual([]);
    expect(
      protectionTextSegments(text, annotations, "surrogates")
        .map((segment) => segment.text)
        .join(""),
    ).toBe(`Email ${surrogate}`);
    expect(part.metadata.provider).toBe("keep");
  });

  it("strips only Ficta display metadata and raw markers at the model boundary", () => {
    const message = {
      role: "user",
      parts: [
        {
          type: "text",
          content: `Email ${marked(surrogate, "jane.doe@example.com", "detected")}`,
          metadata: {
            provider: "keep",
            fictaProtection: [{ start: 6, end: 26, surrogate, origin: "detected", direction: "redacted" }],
          },
        },
      ],
    };

    expect(stripProtectionDisplayMetadata(message)).toEqual({
      role: "user",
      parts: [
        {
          type: "text",
          content: "Email jane.doe@example.com",
          metadata: { provider: "keep" },
        },
      ],
    });
  });
});

describe("restore highlight presentation", () => {
  it("matches the send-review registry, detected, and user underline key", () => {
    expect(restoreHighlightPresentation("registry")).toEqual({
      tooltipLabel: "Protected Registry · restored locally",
      borderClass: "border-emerald-600",
    });
    expect(restoreHighlightPresentation("detected")).toMatchObject({
      tooltipLabel: "Detected PII · restored locally",
      borderClass: "border-emerald-600 border-dashed",
    });
    expect(restoreHighlightPresentation("user")).toEqual({
      tooltipLabel: "Protected by you · restored locally",
      borderClass: "border-foreground",
    });
  });
});

describe("hasVisibleRestorations", () => {
  it("is true only when a restoration value appears in the text", () => {
    const restorations = [
      {
        value: "jane.doe@example.com",
        surrogate: "FICTA_00000000000000000000000000000001",
        origin: "detected" as const,
      },
    ];
    expect(hasVisibleRestorations("Email: jane.doe@example.com", restorations)).toBe(true);
    expect(hasVisibleRestorations("Email redacted", restorations)).toBe(false);
  });
});

describe("stripRestoreHighlightMarkers", () => {
  it("strips markers recursively before storage or model replay", () => {
    const surrogate = "FICTA_EMAIL_1234567890abcdef1234567890abcdef";
    const message = {
      parts: [{ type: "text", content: `Email: ${marked(surrogate, "jane.doe@example.com", "detected")}` }],
    };

    expect(stripRestoreHighlightMarkers(message)).toEqual({
      parts: [{ type: "text", content: "Email: jane.doe@example.com" }],
    });
  });

  it("returns the original graph unchanged (no clone) when there are no markers", () => {
    // Traffic from clients that do not request highlights carries no markers, so the strip must not deep-clone: it should
    // hand back the exact same object/array references it was given.
    const parts = [{ type: "text", content: "Email: jane.doe@example.com" }];
    const message = { parts };
    const result = stripRestoreHighlightMarkers(message);

    expect(result).toBe(message);
    expect(result.parts).toBe(parts);
  });
});
