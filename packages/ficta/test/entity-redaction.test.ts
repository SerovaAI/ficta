import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import type { DetectorPlugin, ProtectedValue } from "../src/plugins/index.js";

describe("occurrence-based body redaction", () => {
  afterEach(() => {
    delete process.env.FICTA_BODY_REDACTION_LEGACY;
    delete process.env.FICTA_SURROGATE_STYLE;
  });

  it("lets a registry entity own an inner span and redacts the detector's clipped residual", async () => {
    const registry = "Project Copper Kite";
    const detected = "Project:** Project Copper Kite";
    const engine = new ProtectionEngine({
      plugins: [spanDetector(detected, "organization")],
      values: [{ name: "PROJECT", value: registry, source: "env-file", kind: "secret", confidence: "exact" }],
    });
    const body = JSON.stringify({ content: detected });
    const redacted = await engine.redactBodyDetailed(body, { traceValues: true });

    expect(redacted.leaks).toBe(0);
    expect(redacted.count).toBe(2);
    expect(redacted.body).not.toContain("Project:**");
    expect(redacted.body).not.toContain(registry);
    expect(redacted.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "organization", source: "fixture-detector" }),
        expect.objectContaining({ name: "PROJECT", source: "env-file", confidence: "exact" }),
      ]),
    );
    expect(engine.restoreText(redacted.body)).toContain(detected);
    expect(redacted.traceValues?.find((value) => value.name === "PROJECT")?.provenance).toBe("permanent");
  });

  it("gives the registry permanent provenance on an exact-range tie in both surrogate styles", async () => {
    for (const style of ["opaque", "typed"] as const) {
      process.env.FICTA_SURROGATE_STYLE = style;
      const value = "Proxima Medical\nSupplies CC";
      const engine = new ProtectionEngine({
        plugins: [spanDetector(value, "organization")],
        values: [
          {
            name: "OPPOSING_PARTY",
            value: "Proxima Medical Supplies CC",
            source: "env-file",
            kind: "secret",
            confidence: "exact",
          },
        ],
      });
      const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: value }), { traceValues: true });
      expect(redacted.count).toBe(1);
      expect(redacted.hits).toEqual([
        expect.objectContaining({ name: "OPPOSING_PARTY", source: "env-file", confidence: "exact" }),
      ]);
      expect(redacted.traceValues?.[0]?.provenance).toBe("permanent");
      if (style === "typed") expect(redacted.body).toMatch(/FICTA_SECRET_[0-9a-f]{32}/);
      expect(engine.restoreText(redacted.body)).toContain(value);
    }
  });

  it("maps a detector span across adjacent value leaves without ever detecting structural keys", async () => {
    let detectionView = "";
    const detector: DetectorPlugin = {
      kind: "detector",
      name: "joined-detector",
      bodyDetectionView: "content",
      detectText: (text) => {
        detectionView = text;
        const surface = "Proxima\nMedical";
        const start = text.indexOf(surface);
        return start === -1 ? [] : [pii("organization", surface, [{ start, end: start + surface.length }])];
      },
    };
    const engine = new ProtectionEngine({ plugins: [detector] });
    const body = JSON.stringify({ secretStructuralKey: "Proxima", next: "Medical" });
    const redacted = await engine.redactBodyDetailed(body);

    expect(detectionView).toBe("Proxima\nMedical");
    expect(detectionView).not.toContain("secretStructuralKey");
    expect(redacted.count).toBe(2);
    expect(redacted.leaks).toBe(0);
    expect(engine.restoreText(redacted.body)).toContain("Proxima");
    expect(engine.restoreText(redacted.body)).toContain("Medical");
  });

  it("falls back from a spanless detector value to exact occurrences and still expands casing", async () => {
    const detector: DetectorPlugin = {
      kind: "detector",
      name: "spanless-detector",
      detectText: () => [pii("person", "Viven Bhowani")],
    };
    const engine = new ProtectionEngine({ plugins: [detector] });
    const body = JSON.stringify({ content: "Viven Bhowani signed; VIVEN BHOWANI approved." });
    const redacted = await engine.redactBodyDetailed(body);
    expect(redacted.count).toBe(2);
    expect(redacted.body).not.toContain("Viven Bhowani");
    expect(redacted.body).not.toContain("VIVEN BHOWANI");
    expect(redacted.leaks).toBe(0);
  });

  it("keeps registry and expansion coverage on structural keys", async () => {
    const value = "Confidential Client";
    const engine = new ProtectionEngine({
      plugins: [],
      values: [{ name: "CLIENT", value, source: "fixture", kind: "secret", confidence: "exact" }],
    });
    const redacted = await engine.redactBodyDetailed(JSON.stringify({ [value.toUpperCase()]: "ordinary value" }));
    expect(redacted.count).toBe(1);
    expect(redacted.body).not.toContain(value.toUpperCase());
    expect(redacted.leaks).toBe(0);
    expect(engine.restoreJson(redacted.body)).toContain(value.toUpperCase());
  });

  it("keeps clipped residuals token-only across keyed turns", async () => {
    const registry = "Project Copper Kite";
    const detected = "Project:** Project Copper Kite";
    const engine = new ProtectionEngine({
      plugins: [spanDetector(detected, "organization")],
      values: [{ name: "PROJECT", value: registry, source: "env-file", kind: "secret", confidence: "exact" }],
    });
    const key = "org:clipped-residual";
    const first = await engine.beginRequest(key).redactBodyDetailed(JSON.stringify({ content: detected }));
    expect(first.body).not.toContain("Project:**");

    const second = await engine.beginRequest(key).redactBodyDetailed(JSON.stringify({ content: "Project:** alone" }));
    expect(second.body).toContain("Project:** alone");
    expect(second.leaks).toBe(0);
  });

  it("preserves complete non-whitespace coverage through seeded body-level overlap cases", async () => {
    const random = mulberry32(0x4f434355);
    for (let i = 0; i < 40; i++) {
      const left = `LEFT${i}${Math.floor(random() * 10_000)}X`;
      const registry = `SECRET${i}${Math.floor(random() * 10_000)}Z`;
      const right = `RIGHT${i}${Math.floor(random() * 10_000)}Y`;
      const detected = `${left}  ${registry}  ${right}`;
      const engine = new ProtectionEngine({
        plugins: [spanDetector(detected, "organization")],
        values: [{ name: "REGISTERED", value: registry, source: "fixture", kind: "secret", confidence: "exact" }],
      });
      const result = await engine.redactBodyDetailed(JSON.stringify({ content: detected }));
      expect(result.leaks).toBe(0);
      expect(result.body).not.toContain(left);
      expect(result.body).not.toContain(registry);
      expect(result.body).not.toContain(right);
      expect(engine.restoreText(result.body)).toContain(detected);
    }
  });
});

function spanDetector(value: string, name: string): DetectorPlugin {
  return {
    kind: "detector",
    name: "fixture-detector",
    detectText: (text) => {
      const start = text.indexOf(value);
      return start === -1 ? [] : [pii(name, value, [{ start, end: start + value.length }])];
    },
  };
}

function pii(name: string, value: string, spans?: ProtectedValue["spans"]): ProtectedValue {
  return {
    name,
    value,
    source: "fixture-detector",
    kind: "pii",
    confidence: "high",
    ...(spans ? { spans } : {}),
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
