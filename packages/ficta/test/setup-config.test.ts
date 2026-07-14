import { describe, expect, it } from "vitest";
import { normalizePiiBackendConfig } from "../src/setup.js";

describe("setup config normalization", () => {
  it("migrates the legacy singular PII backend without changing its effective value", () => {
    const input = {
      FICTA_PII_ENABLED: "1",
      FICTA_PII_BACKEND: "presidio",
    };

    expect(normalizePiiBackendConfig(input)).toEqual({
      FICTA_PII_ENABLED: "1",
      FICTA_PII_BACKENDS: "presidio",
    });
    expect(input).toHaveProperty("FICTA_PII_BACKEND", "presidio");
  });

  it("keeps the canonical backend list when both settings exist", () => {
    expect(
      normalizePiiBackendConfig({
        FICTA_PII_BACKEND: "regex",
        FICTA_PII_BACKENDS: "presidio,openmed",
      }),
    ).toEqual({ FICTA_PII_BACKENDS: "presidio,openmed" });
  });
});
