import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL("../../../scripts/dev-runner.mjs", import.meta.url));

describe("source-checkout Presidio runner", () => {
  it("builds the Ficta Presidio extension and mounts both analyzer configurations", () => {
    const runner = readFileSync(runnerPath, "utf8");

    expect(runner).toContain("FICTA_PII_PRESIDIO_CONFIG_FILE");
    expect(runner).toContain("FICTA_PII_PRESIDIO_NLP_CONFIG_FILE");
    expect(runner).toContain("default_recognizers.yaml");
    expect(runner).toContain("nlp_engine.za.yaml");
    expect(runner).toContain("RECOGNIZER_REGISTRY_CONF_FILE=");
    expect(runner).toContain("NLP_CONF_FILE=");
    expect(runner).toContain("packages/ficta/presidio");
    expect(runner).toContain('"build", "-t", image, DEFAULT_PRESIDIO_CONTEXT');
  });
});
