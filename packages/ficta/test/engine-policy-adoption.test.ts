import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine, profileEngineConfig, ProtectionEngine, resolveEngineConfig } from "@serovaai/ficta-engine";
import { engineConfigFromEnv } from "../src/engine-env.js";
import { readUserConfig, writeUserConfig } from "../src/user-config.js";

const KEY = "shared-policy-test-key-at-least-32-bytes";
describe("engine policies through the proxy adapter", () => {
  it("preserves profiles through TOML round trips and produces the same redaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-policies-"));
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      `[detection]\nfail_closed = true\nentity_priority = ["za-id-number", "credit-card"]\n[redaction]\nredact_paths = true\n[pii]\nenabled = true\nbackends = ["regex"]\nfail_closed = true\n[dispositions.destroy]\ncategories = ["credit-card"]\n[dispositions.destroy.labels]\ncredit-card = "[REMOVED_CARD]"\n`,
      { mode: 0o600 },
    );
    const settings = readUserConfig(path);
    expect(settings.FICTA_DESTROY_LABELS).toBe(JSON.stringify({ "credit-card": "[REMOVED_CARD]" }));
    writeUserConfig(settings, path);
    expect(readUserConfig(path)).toEqual(settings);
    expect(readFileSync(path, "utf8")).toContain("[dispositions.destroy.labels]");
    const proxyConfig = engineConfigFromEnv({ ...settings, FICTA_SURROGATE_KEY: KEY });
    const profile = { destroy: { categories: ["credit-card"], labels: { "credit-card": "[REMOVED_CARD]" } } };
    const libraryConfig = profileEngineConfig(profile, {
      surrogate: { key: KEY },
      detection: { entityPriority: ["za-id-number", "credit-card"] },
      pii: { backends: ["regex"] },
    });
    expect(proxyConfig).toEqual(libraryConfig);
    expect(resolveEngineConfig(proxyConfig)).toEqual(proxyConfig);
    const library = await createEngine({ surrogateKey: KEY, profiles: { rules: profile } });
    const proxy = new ProtectionEngine({ config: proxyConfig });
    const text = "Email person@example.com; card 4111 1111 1111 1111.";
    try {
      expect((await proxy.redactContentDetailed(text)).text).toBe((await library.redactMany([text], "rules")).texts[0]);
    } finally {
      await library.close();
    }
  });
  it("keeps destroy-all through repeated config resolution", () => {
    const config = engineConfigFromEnv({ FICTA_DESTROY_CATEGORIES: "*" });
    expect(config.dispositions.destroy.all).toBe(true);
    expect(resolveEngineConfig(config)).toEqual(config);
  });
  it("rejects malformed label settings without echoing their contents", () => {
    expect(() => engineConfigFromEnv({ FICTA_DESTROY_LABELS: "private-value" })).toThrow("expected a JSON object");
    expect(() => engineConfigFromEnv({ FICTA_DESTROY_LABELS: '{"credit-card":42}' })).toThrow("expected a JSON object");
  });
});
