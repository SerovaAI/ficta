import { beforeAll, describe, expect, it } from "vitest";
import {
  characterizeRenderedFixture,
  type EntityFidelityFixture,
  entityIdForToken,
  loadEntityFidelityFixture,
  mutateToken,
  type RenderedFixture,
  renderEntityFidelityFixture,
  restoreFragmented,
  restoreText,
  type SurrogateStyle,
  tokenForSurface,
} from "../bench/entity-surrogate-fidelity-lib.js";

const STYLES: SurrogateStyle[] = ["opaque", "typed", "entity-family"];

let fixture: EntityFidelityFixture;
let rendered: Record<SurrogateStyle, RenderedFixture>;

beforeAll(async () => {
  fixture = await loadEntityFidelityFixture();
  rendered = {
    opaque: renderEntityFidelityFixture(fixture, "opaque"),
    typed: renderEntityFidelityFixture(fixture, "typed"),
    "entity-family": renderEntityFidelityFixture(fixture, "entity-family"),
  };
});

describe("Phase 0 entity-surrogate legal fidelity", () => {
  for (const style of STYLES) {
    it(`${style} protects identities, retains material facts, and restores exactly`, () => {
      const result = characterizeRenderedFixture(fixture, rendered[style]);
      expect(result.protectedSurfacesAbsent).toBe(true);
      expect(result.materialFactsVisible).toBe(true);
      expect(result.exactRoundTrip).toBe(true);
    });
  }

  it("characterizes current tokens as surface-specific and candidate tokens as entity-family-specific", () => {
    const canonical = "Northstar Biologics (Pty) Ltd";
    const short = "Northstar";

    for (const style of ["opaque", "typed"] as const) {
      expect(tokenForSurface(rendered[style], canonical)).not.toBe(tokenForSurface(rendered[style], short));
    }

    const canonicalMapping = rendered["entity-family"].mappings.find((mapping) => mapping.surface === canonical);
    const shortMapping = rendered["entity-family"].mappings.find((mapping) => mapping.surface === short);
    expect(tokenForSurface(rendered["entity-family"], canonical)).toBe("FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH");
    expect(canonicalMapping?.entityTag).toMatch(/^[A-Z2-7]{12}$/u);
    expect(canonicalMapping?.entityTag).toBe(shortMapping?.entityTag);
    expect(canonicalMapping?.surfaceTag).toMatch(/^[A-Z2-7]{12}$/u);
    expect(canonicalMapping?.surfaceTag).not.toBe(shortMapping?.surfaceTag);
  });

  it("keeps literals on the shipped opaque or typed strategies", () => {
    const account = "ZA-TRUST-0042";
    expect(tokenForSurface(rendered.opaque, account)).toMatch(/^FICTA_[0-9a-f]{32}$/u);
    expect(tokenForSurface(rendered.typed, account)).toMatch(/^FICTA_ACCOUNT_[0-9a-f]{32}$/u);
    expect(tokenForSurface(rendered["entity-family"], account)).toMatch(/^FICTA_[0-9a-f]{32}$/u);
  });

  it("keeps the candidate family and surface tags protection-context scoped", () => {
    const otherContext = structuredClone(fixture);
    otherContext.protectionContextId = "thread:separate-fidelity-fixture";
    const first = rendered["entity-family"].mappings.find((mapping) => mapping.kind === "entity");
    const second = renderEntityFidelityFixture(otherContext, "entity-family").mappings.find(
      (mapping) => mapping.surface === first?.surface,
    );

    expect(first?.entityTag).not.toBe(second?.entityTag);
    expect(first?.surfaceTag).not.toBe(second?.surfaceTag);
    expect(first?.token).not.toBe(second?.token);
  });

  it("round-trips casing, Markdown, possessives, repeats, and reflowed forms byte-for-byte", () => {
    const candidate = rendered["entity-family"];
    const uppercase = tokenForSurface(candidate, "NORTHSTAR");
    const markdown = tokenForSurface(candidate, "Northstar");
    const reflowed = tokenForSurface(candidate, "Proxima Medical\nSupplies CC");

    expect(candidate.text).toContain(`${uppercase} sent a breach notice`);
    expect(candidate.text).toContain(`**${markdown}** alleges`);
    expect(candidate.text).toContain(`${markdown}'s finance tracker`);
    expect(candidate.text).toContain(`as:\n${reflowed}\n`);
    expect(restoreText(candidate.text, candidate.mappings)).toBe(candidate.sourceText);
  });

  it("never maps a mutated candidate token to a registered entity", () => {
    const candidate = rendered["entity-family"];
    const token = tokenForSurface(candidate, "Northstar");
    const mutated = mutateToken(token);
    const restored = restoreText(mutated, candidate.mappings);

    expect(restored).toBe(mutated);
    expect(restored).not.toContain("Northstar");
    expect(entityIdForToken(candidate, mutated)).toBeUndefined();
  });
});

describe("Phase 0 entity-surrogate transport fidelity", () => {
  it("restores every candidate token across every possible two-chunk split", () => {
    const candidate = rendered["entity-family"];
    for (const mapping of candidate.mappings) {
      const text = `before ${mapping.token} after`;
      for (let cut = 1; cut < text.length; cut += 1) {
        expect(restoreFragmented([text.slice(0, cut), text.slice(cut)], candidate.mappings)).toBe(
          `before ${mapping.surface} after`,
        );
      }
    }
  });

  it("restores a candidate token delivered one character per chunk", () => {
    const candidate = rendered["entity-family"];
    const token = tokenForSurface(candidate, "Northstar");
    expect(restoreFragmented([...token], candidate.mappings)).toBe("Northstar");
  });

  it("survives buffered and streaming provider wire shapes without token mutation", () => {
    const candidate = rendered["entity-family"];
    const token = tokenForSurface(candidate, "Northstar");
    const surface = "Northstar";
    const records = [
      { type: "content_block_delta", delta: { type: "text_delta", text: token } },
      { choices: [{ delta: { content: token } }] },
      { type: "response.output_text.delta", delta: token },
      { content: [{ type: "text", text: token }] },
      { output: [{ type: "message", content: [{ type: "output_text", text: token }] }] },
    ];

    for (const record of records) {
      const encoded = JSON.stringify(record);
      expect(JSON.parse(encoded)).toEqual(record);
      expect(encoded).toContain(token);
      expect(restoreText(encoded, candidate.mappings)).toContain(surface);
    }
  });

  it("survives Anthropic, Chat Completions, and Responses tool-argument encodings", () => {
    const candidate = rendered["entity-family"];
    const token = tokenForSurface(candidate, "Proxima");
    const surface = "Proxima";
    const records = [
      { content: [{ type: "tool_use", input: { responsible_party: token } }] },
      {
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: JSON.stringify({ responsible_party: token }) } }],
            },
          },
        ],
      },
      { output: [{ type: "function_call", arguments: JSON.stringify({ responsible_party: token }) }] },
    ];

    for (const record of records) {
      const encoded = JSON.stringify(record);
      expect(encoded).toContain(token);
      expect(restoreText(encoded, candidate.mappings)).toContain(surface);
    }
  });
});
