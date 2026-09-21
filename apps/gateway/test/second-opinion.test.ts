import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PROTECTION_REVIEW_SECOND_OPINION_COPY,
  PROTECTION_REVIEW_SECOND_OPINION_LEGEND,
  PROTECTION_REVIEW_SECOND_OPINION_LINE_TITLE,
  ProtectionReview,
} from "@/components/chat/ProtectionReview";
import { TooltipProvider } from "@/components/ui/tooltip";
import { flaggedLineCount, isSecondOpinion, type SecondOpinion, secondOpinionLabelFor } from "@/lib/second-opinion";
import {
  assessProtectionPreview,
  lineRanges,
  prepareSecondOpinion,
  SECOND_OPINION_LINES_MAX,
  secondOpinionAvailability,
  secondOpinionConfig,
  substituteSpans,
} from "@/lib/second-opinion.server";
import {
  AdminSettingsForm,
  SECOND_OPINION_SETTING_LABEL,
  secondOpinionPinnedNote,
} from "@/components/settings/AdminSettingsForm";
import { validateInstancePatch } from "@/lib/storage/settings";

const TEXT = [
  "Client: Northstar Biologics",
  "Northstar owes ZAR 8,750,000 by 30 June.",
  "Signed by Alice Example",
].join("\n");

function finding(
  value: string,
  origin: ProtectionPreviewFinding["origin"],
  surrogate: string,
): ProtectionPreviewFinding {
  const start = TEXT.indexOf(value);
  if (start === -1) throw new Error(`fixture value missing: ${value}`);
  return {
    name: origin === "registry" ? "organization" : "person",
    source: origin === "registry" ? "registry" : "pii-presidio",
    kind: "pii",
    confidence: origin === "registry" ? "exact" : "probabilistic",
    start,
    end: start + value.length,
    surrogate,
    origin,
  };
}

const REGISTRY = finding("Northstar Biologics", "registry", "FICTA_ORG_AAAAAAAAAAAA_BBBBBBBBBBBB");
const DETECTED = finding("Alice Example", "detected", "FICTA_PERSON_CCCCCCCCCCCC_DDDDDDDDDDDD");
const FINDINGS = [REGISTRY, DETECTED];
const CONFIG = { apiKey: "test-key", model: "jev-1.13.0", timeoutMs: 1_000 };

describe("second opinion configuration", () => {
  it("exists only with a server key and is switched by the admin setting unless env pins it", () => {
    expect(secondOpinionAvailability({})).toEqual({ available: false });
    expect(secondOpinionAvailability({ TYPESAFE_API_KEY: "k" })).toEqual({ available: true });
    expect(secondOpinionAvailability({ TYPESAFE_API_KEY: "k", FICTA_GATEWAY_SECOND_OPINION: " Off " })).toEqual({
      available: true,
      pinned: "off",
    });

    expect(secondOpinionConfig({})).toBeNull();
    expect(secondOpinionConfig({ FICTA_GATEWAY_SECOND_OPINION: "on" })).toBeNull();
    // Key present, nothing pinned: the admin setting decides, default off.
    expect(secondOpinionConfig({ TYPESAFE_API_KEY: "k" })).toBeNull();
    expect(secondOpinionConfig({ TYPESAFE_API_KEY: "k" }, { secondOpinionEnabled: true })?.apiKey).toBe("k");
    // Env pins win over the admin setting in both directions.
    expect(
      secondOpinionConfig(
        { TYPESAFE_API_KEY: "k", FICTA_GATEWAY_SECOND_OPINION: "off" },
        { secondOpinionEnabled: true },
      ),
    ).toBeNull();
    // Only the literal on/off pin; any other value leaves the decision with the admin setting.
    expect(
      secondOpinionConfig(
        { FICTA_GATEWAY_SECOND_OPINION: "true", TYPESAFE_API_KEY: "k" },
        { secondOpinionEnabled: true },
      )?.apiKey,
    ).toBe("k");
    expect(secondOpinionConfig({ FICTA_GATEWAY_SECOND_OPINION: "true", TYPESAFE_API_KEY: "k" })).toBeNull();
    expect(secondOpinionConfig({ FICTA_GATEWAY_SECOND_OPINION: " ON ", TYPESAFE_API_KEY: " k " })).toEqual({
      apiKey: "k",
      model: "jev-1.13.0",
      timeoutMs: 4_000,
    });
    expect(
      secondOpinionConfig({
        FICTA_GATEWAY_SECOND_OPINION: "on",
        TYPESAFE_API_KEY: "k",
        FICTA_GATEWAY_SECOND_OPINION_MODEL: "jev-1.14.0",
        FICTA_GATEWAY_SECOND_OPINION_TIMEOUT_MS: "250",
      }),
    ).toEqual({ apiKey: "k", model: "jev-1.14.0", timeoutMs: 250 });
    expect(
      secondOpinionConfig({
        FICTA_GATEWAY_SECOND_OPINION: "on",
        TYPESAFE_API_KEY: "k",
        FICTA_GATEWAY_SECOND_OPINION_TIMEOUT_MS: "-1",
      })?.timeoutMs,
    ).toBe(4_000);
  });
});

describe("registry substitution", () => {
  it("splits lines on newlines and keeps offsets into the original text", () => {
    expect(lineRanges("a\nbc\n")).toEqual([
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 2, end: 4 },
      { line: 2, start: 5, end: 5 },
    ]);
  });

  it("replaces only the selected origins and never leaks a registry fragment across a line", () => {
    const line0 = lineRanges(TEXT)[0]!;
    expect(substituteSpans(TEXT, line0.start, line0.end, FINDINGS, (f) => f.origin === "registry")).toBe(
      `Client: ${REGISTRY.surrogate}`,
    );
    const line2 = lineRanges(TEXT)[2]!;
    expect(substituteSpans(TEXT, line2.start, line2.end, FINDINGS, (f) => f.origin === "registry")).toBe(
      "Signed by Alice Example",
    );
    expect(substituteSpans(TEXT, line2.start, line2.end, FINDINGS, () => true)).toBe(`Signed by ${DETECTED.surrogate}`);
    // A span crossing the range boundary contributes the whole surrogate for the overlapped part.
    const crossing: ProtectionPreviewFinding = { ...REGISTRY, start: 4, end: 12, surrogate: "FICTA_X" };
    expect(substituteSpans("abcdefghijkl", 0, 8, [crossing], () => true)).toBe("abcdFICTA_X");
  });

  it("never places a registry value in the request state", () => {
    const prepared = prepareSecondOpinion(TEXT, FINDINGS);
    if ("skipped" in prepared) throw new Error("unexpected skip");
    const serialized = JSON.stringify(prepared.state);
    expect(serialized).not.toContain("Northstar Biologics");
    expect(serialized).toContain(REGISTRY.surrogate);
    // Detected spans are judged as text, with their registry-substituted line.
    expect(prepared.state.candidates).toEqual([{ id: 0, span: "Alice Example", line: "Signed by Alice Example" }]);
    expect(Object.keys(prepared.questions).sort()).toEqual(["c0", "c1", "c2", "f0", "p0", "p1", "p2"]);
  });

  it("skips oversize input and blank lines", () => {
    const many = Array.from({ length: SECOND_OPINION_LINES_MAX + 1 }, () => "x").join("\n");
    expect(prepareSecondOpinion(many, [])).toEqual({ skipped: "too_many_lines" });
    expect(prepareSecondOpinion("y".repeat(25 * 1024), [])).toEqual({ skipped: "too_large" });
    const prepared = prepareSecondOpinion("one\n\n\nfour", []);
    if ("skipped" in prepared) throw new Error("unexpected skip");
    expect(prepared.state.lines.map((line) => line.id)).toEqual([0, 3]);
  });
});

describe("assessment", () => {
  const answers = {
    p0: { type: "noul", noul: 0.05 },
    c0: { type: "noul", noul: 0.1 },
    p1: { type: "noul", noul: 0.2 },
    c1: { type: "noul", noul: 0.93 },
    p2: { type: "noul", noul: 0.4 },
    c2: { type: "noul", noul: 0.1 },
    f0: { type: "choice", choice: "person", confidence: 0.97, probabilities: { person: 0.98 } },
  };

  function fetchWith(body: unknown, status = 200): typeof fetch {
    return vi.fn(
      async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
  }

  it("flags lines above threshold and labels detected findings by original offsets", async () => {
    const fetchImpl = fetchWith({ model: "jev-1.13.0", answers, usage: { input_tokens: 321, output_tokens: 7 } });
    const opinion = await assessProtectionPreview({ text: TEXT, findings: FINDINGS }, CONFIG, { fetch: fetchImpl });
    expect(opinion.status).toBe("ok");
    expect(opinion.model).toBe("jev-1.13.0");
    expect(opinion.lines).toEqual([{ line: 1, start: 28, end: 68, party: 0.2, fact: 0.93 }]);
    expect(opinion.findings).toEqual([{ start: DETECTED.start, end: DETECTED.end, kind: "person", confidence: 0.97 }]);
    expect(flaggedLineCount(opinion)).toBe(1);
    expect(secondOpinionLabelFor(opinion, DETECTED.start, DETECTED.end)?.kind).toBe("person");
    expect(isSecondOpinion(JSON.parse(JSON.stringify(opinion)))).toBe(true);

    const request = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(String((request[1] as RequestInit).body));
    expect(body.model).toBe("jev-1.13.0");
    expect(JSON.stringify(body.state)).not.toContain("Northstar Biologics");
  });

  it("drops low-confidence labels and unknown kinds", async () => {
    const weak = { ...answers, f0: { type: "choice", choice: "person", confidence: 0.3, probabilities: {} } };
    const opinion = await assessProtectionPreview({ text: TEXT, findings: FINDINGS }, CONFIG, {
      fetch: fetchWith({ model: "jev-1.13.0", answers: weak, usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    expect(opinion.findings).toEqual([]);
  });

  it("fails open on rate limiting, timeouts, and malformed responses", async () => {
    const limited = await assessProtectionPreview({ text: TEXT, findings: FINDINGS }, CONFIG, {
      fetch: fetchWith({ error: "slow down" }, 429),
    });
    expect(limited.status).toBe("unavailable");
    expect(limited.lines).toEqual([]);

    const hanging = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const timedOut = await assessProtectionPreview(
      { text: TEXT, findings: FINDINGS },
      { ...CONFIG, timeoutMs: 20 },
      {
        fetch: hanging,
      },
    );
    expect(timedOut.status).toBe("unavailable");

    const garbage = await assessProtectionPreview({ text: TEXT, findings: FINDINGS }, CONFIG, {
      fetch: fetchWith("not json at all"),
    });
    expect(garbage.status).toBe("unavailable");
  });

  it("reports skips without contacting the service", async () => {
    const fetchImpl = fetchWith({});
    const many = Array.from({ length: SECOND_OPINION_LINES_MAX + 1 }, () => "x").join("\n");
    const opinion = await assessProtectionPreview({ text: many, findings: [] }, CONFIG, { fetch: fetchImpl });
    expect(opinion).toEqual({ status: "skipped", reason: "too_many_lines", findings: [], lines: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("admin setting", () => {
  it("validates the instance patch as a strict boolean", () => {
    expect(validateInstancePatch({ secondOpinionEnabled: true })).toEqual({ secondOpinionEnabled: true });
    expect(validateInstancePatch({ secondOpinionEnabled: false })).toEqual({ secondOpinionEnabled: false });
    expect(() => validateInstancePatch({ secondOpinionEnabled: "on" })).toThrow("invalid secondOpinionEnabled");
  });

  it("shows the toggle only when the server has a key, read-only when env pins it", () => {
    const render = (props: Parameters<typeof AdminSettingsForm>[0]) =>
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AdminSettingsForm, props)));
    const hidden = render({ settings: {} });
    expect(hidden).not.toContain(SECOND_OPINION_SETTING_LABEL);

    const editable = render({ settings: { secondOpinionEnabled: true }, secondOpinion: { available: true } });
    expect(editable).toContain(SECOND_OPINION_SETTING_LABEL);
    expect(editable).toContain('id="second-opinion-enabled"');
    expect(editable).toContain('data-state="checked"');
    expect(editable).not.toContain(secondOpinionPinnedNote("on"));

    const pinnedOff = render({
      settings: { secondOpinionEnabled: true },
      secondOpinion: { available: true, pinned: "off" },
    });
    expect(pinnedOff).toContain(secondOpinionPinnedNote("off"));
    expect(pinnedOff).toContain('data-state="unchecked"');
    const toggleTag = (html: string) => /<button[^>]*id="second-opinion-enabled"[^>]*>/.exec(html)?.[0] ?? "";
    // The attribute, not the `disabled:` Tailwind variants in the class list.
    expect(toggleTag(pinnedOff)).toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(toggleTag(editable)).not.toMatch(/\sdisabled(?:=""|\s|>)/);
  });
});

describe("second opinion shape guard", () => {
  it("accepts only well-formed advisory results", () => {
    expect(isSecondOpinion({ status: "ok", findings: [], lines: [] })).toBe(true);
    expect(isSecondOpinion({ status: "unavailable", reason: "APITimeoutError", findings: [], lines: [] })).toBe(true);
    expect(isSecondOpinion({ status: "maybe", findings: [], lines: [] })).toBe(false);
    expect(
      isSecondOpinion({ status: "ok", findings: [{ start: 3, end: 2, kind: "person", confidence: 1 }], lines: [] }),
    ).toBe(false);
    expect(
      isSecondOpinion({ status: "ok", findings: [], lines: [{ line: 0, start: 0, end: 4, party: 1.2, fact: 0 }] }),
    ).toBe(false);
    expect(isSecondOpinion(undefined)).toBe(false);
  });
});

describe("review rendering", () => {
  const preview = {
    ticket: "t",
    textSha256: "s",
    redactedText: TEXT,
    findings: [DETECTED],
    protectedValues: [],
  };
  const noop = async () => {};

  function render(secondOpinion?: SecondOpinion): string {
    return renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(ProtectionReview, {
          text: TEXT,
          preview: { ...preview, ...(secondOpinion ? { secondOpinion } : {}) },
          busy: false,
          onBack: () => {},
          onProtect: noop,
          onRemove: noop,
          onSend: () => {},
          onSuggest: () => {},
          suggestValues: [],
          modelSummary: "model",
        }),
      ),
    );
  }

  it("marks flagged lines and labels detected findings when a second opinion is present", () => {
    const html = render({
      status: "ok",
      model: "jev-1.13.0",
      findings: [{ start: DETECTED.start, end: DETECTED.end, kind: "person", confidence: 0.97 }],
      lines: [{ line: 1, start: 28, end: 68, party: 0.2, fact: 0.93 }],
    });
    expect(html).toContain(PROTECTION_REVIEW_SECOND_OPINION_LEGEND);
    expect(html).toContain(PROTECTION_REVIEW_SECOND_OPINION_COPY);
    expect(html).toContain(`title="${PROTECTION_REVIEW_SECOND_OPINION_LINE_TITLE}"`);
    expect(html).toContain('data-second-opinion="line"');
    expect(html).toContain("Northstar owes ZAR 8,750,000 by 30 June.");
  });

  it("renders nothing extra when the second opinion is absent or unavailable", () => {
    for (const html of [render(), render({ status: "unavailable", reason: "x", findings: [], lines: [] })]) {
      expect(html).not.toContain(PROTECTION_REVIEW_SECOND_OPINION_LEGEND);
      expect(html).not.toContain("data-second-opinion");
      expect(html).toContain("Detected identity");
    }
  });
});
