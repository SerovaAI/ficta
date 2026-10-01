import { describe, expect, it } from "vitest";
import { MissingSurrogateKeyError, ProtectionEngine } from "../src/index.js";

const KEY = "library-caller-surrogate-key-at-least-32-bytes";
const VALUE = { name: "SECRET", value: "registered-value-123456", source: "test" };

describe("surrogate key requirement", () => {
  it("refuses to construct without a surrogate key", () => {
    expect(() => new ProtectionEngine()).toThrow(MissingSurrogateKeyError);
    expect(() => new ProtectionEngine({ config: { surrogate: { style: "typed" } } })).toThrow(
      /needs a surrogate key: pass config.surrogate.key/,
    );
  });

  it("treats an empty key as missing", () => {
    expect(() => new ProtectionEngine({ config: { surrogate: { key: "" } } })).toThrow(MissingSurrogateKeyError);
  });

  it("constructs with an explicit key, and the same key mints the same surrogates", async () => {
    const body = JSON.stringify({ v: VALUE.value });
    const first = new ProtectionEngine({ plugins: [], values: [VALUE], config: { surrogate: { key: KEY } } });
    const second = new ProtectionEngine({ plugins: [], values: [VALUE], config: { surrogate: { key: KEY } } });

    const redacted = (await first.redactBodyDetailed(body)).body;
    expect(redacted).not.toContain(VALUE.value);
    expect((await second.redactBodyDetailed(body)).body).toBe(redacted);
    expect(second.restoreText(redacted)).toBe(body);
  });

  it("falls back to a per-process key only when the host opts in", async () => {
    const engine = new ProtectionEngine({ plugins: [], values: [VALUE], allowEphemeralKey: true });
    const redacted = (await engine.redactBodyDetailed(JSON.stringify({ v: VALUE.value }))).body;
    expect(redacted).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted)).toContain(VALUE.value);
  });

  it("ships the built-in detectors as the default plugin set", async () => {
    // No `plugins` option: the engine runs the built-in detectors (secret shapes and PII).
    const engine = new ProtectionEngine({ config: { surrogate: { key: KEY } } });
    expect(engine.registryStatus.discoveries.map((d) => d.plugin).sort()).toEqual(["pii", "secret-shapes"]);
  });
});
