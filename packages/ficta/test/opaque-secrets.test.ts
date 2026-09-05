import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { detectSecretShapes, secretShapesPlugin } from "../src/plugins/index.js";

// Synthetic values assembled to keep complete credential-like strings out of source fixtures.
const HEX = ["9b07e2fa", "d4518c36", "a28f04de", "65cb1937", "f0a2e8dc"].join("");
const OPAQUE = ["Zx9Qw8Vt", "7Lm6Pk3J", "Hj4Np2Rd", "5Wb0Ty1F"].join("");

afterEach(() => vi.unstubAllEnvs());

describe("opaque secret detection", () => {
  it("recognizes bare and quoted hex and mixed-alphabet values without names", () => {
    for (const value of [HEX, HEX.repeat(3), OPAQUE, `${OPAQUE}+/==`]) {
      for (const text of [value, `here it is: ${value}\n`, `"${value}"`, `\`${value}\``]) {
        expect(detectSecretShapes(text)).toContainEqual(
          expect.objectContaining({ name: "opaque-secret", value, confidence: "probabilistic" }),
        );
      }
    }
  });

  it("protects a bare paste in a real message body by default and restores it locally", async () => {
    vi.stubEnv("FICTA_SECRET_SHAPES_ENABLED", undefined);
    const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
    const scope = engine.beginRequest("opaque-paste");
    const body = JSON.stringify({ messages: [{ role: "user", content: `${HEX}\n${OPAQUE}` }] });
    const result = await scope.redactBodyDetailed(body);
    expect(result.count).toBe(2);
    expect(result.leaks).toBe(0);
    expect(result.body).not.toContain(HEX);
    expect(result.body).not.toContain(OPAQUE);
    expect(scope.restoreJson(result.body)).toBe(body);
  });

  it("honors the detector opt-out for bare pastes", async () => {
    vi.stubEnv("FICTA_SECRET_SHAPES_ENABLED", "false");
    expect(await secretShapesPlugin.detectText(HEX, { surface: "body" })).toEqual([]);
  });

  it("does not join separate leaves or extract fragments from paths and identifiers", () => {
    for (const text of [
      `${HEX.slice(0, 20)}\u0000${HEX.slice(20)}`,
      `assets/${HEX}.js`,
      `https://example.test/${HEX}`,
      `object.${OPAQUE}`,
      "0123456789".repeat(5),
      "a".repeat(64),
      "aB3".repeat(20),
      "a".repeat(513),
      "getCurrentUserAuthenticationSessionConfiguration",
      "550e8400-e29b-41d4-a716-446655440000",
    ]) {
      expect(detectSecretShapes(text)).toEqual([]);
    }
  });

  it("treats a bare random-looking digest as ambiguous rather than claiming verification", () => {
    expect(detectSecretShapes(HEX)[0]?.confidence).toBe("probabilistic");
  });
});
