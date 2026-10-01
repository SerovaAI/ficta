import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngineConfig, ProtectionEngine, DetectorUnavailableError } from "@serovaai/ficta-engine";
import { engineConfigFromEnv } from "../src/engine-env.js";
import { type DetectorPlugin, piiPlugin, secretShapesPlugin } from "../src/plugins/index.js";

const EMAIL = "alice@example.com";
const KEY_A = "engine-a-surrogate-key-at-least-32-bytes-long";
const KEY_B = "engine-b-surrogate-key-at-least-32-bytes-long";

afterEach(() => vi.unstubAllEnvs());

describe("engine config injection", () => {
  it("runs two engines in one process with independent config", async () => {
    const a = new ProtectionEngine({
      plugins: [piiPlugin],
      config: { surrogate: { key: KEY_A, style: "typed" }, pii: { enabled: true } },
    });
    const b = new ProtectionEngine({
      plugins: [piiPlugin],
      config: { surrogate: { key: KEY_B }, pii: { enabled: false } },
    });
    const body = JSON.stringify({ content: `mail ${EMAIL}` });

    const fromA = await a.redactBodyDetailed(body);
    const fromB = await b.redactBodyDetailed(body);

    // A: PII on, typed tokens under its own key. B: PII off, so the email passes through.
    expect(fromA.body).not.toContain(EMAIL);
    expect(fromA.body).toMatch(/FICTA_EMAIL_[0-9a-f]{32}/);
    expect(fromB.body).toBe(body);
    expect(a.registryStatus.discoveries.find((d) => d.plugin === "pii")?.status).toBe("active");
    expect(b.registryStatus.discoveries.find((d) => d.plugin === "pii")?.status).toBe("disabled");

    // Different keys mint different tokens for the same registered value, and neither engine can
    // restore the other's tokens.
    const value = { name: "SECRET", value: "shared-registry-value-1234", source: "test" };
    const keyedA = new ProtectionEngine({ plugins: [], values: [value], config: { surrogate: { key: KEY_A } } });
    const keyedB = new ProtectionEngine({ plugins: [], values: [value], config: { surrogate: { key: KEY_B } } });
    const tokenA = (await keyedA.redactBodyDetailed(JSON.stringify({ v: value.value }))).body;
    const tokenB = (await keyedB.redactBodyDetailed(JSON.stringify({ v: value.value }))).body;
    expect(tokenA).not.toBe(tokenB);
    expect(keyedA.restoreText(tokenA)).toContain(value.value);
    expect(keyedB.restoreText(tokenA)).not.toContain(value.value);
  });

  it("resolves detector outages against each engine's own fail-closed setting", async () => {
    const crashing: DetectorPlugin = {
      kind: "detector",
      name: "crashing-detector",
      detectText: () => {
        throw new TypeError("boom");
      },
    };
    const closed = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [crashing],
      config: { detection: { failClosed: true } },
    });
    const open = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [crashing],
      config: { detection: { failClosed: false } },
    });
    const body = JSON.stringify({ content: "hello" });

    await expect(closed.redactBodyDetailed(body)).rejects.toBeInstanceOf(DetectorUnavailableError);
    expect((await open.redactBodyDetailed(body)).skippedDetectors).toEqual(["crashing-detector"]);
  });

  it("keeps warn sinks and PII backend failure state per engine", async () => {
    const port = await closedPort();
    const pii = { enabled: true, backends: ["presidio"], presidio: { url: `http://127.0.0.1:${port}` } };
    const warnsA: string[] = [];
    const warnsB: string[] = [];
    const a = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [piiPlugin],
      config: { pii },
      onWarn: (_, m) => warnsA.push(m),
    });
    const b = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [piiPlugin],
      config: { pii },
      onWarn: (_, m) => warnsB.push(m),
    });
    const body = JSON.stringify({ content: `mail ${EMAIL}` });

    await a.redactBodyDetailed(body);
    await a.redactBodyDetailed(body);
    expect(warnsA).toHaveLength(1); // throttled within A
    expect(warnsB).toHaveLength(0); // B has seen no failure yet

    await b.redactBodyDetailed(body);
    expect(warnsB).toHaveLength(1); // B's first failure warns: A's throttle does not apply to B
    expect(warnsB[0]).not.toContain("still unavailable");
  });

  it("does not read the environment after construction", async () => {
    vi.stubEnv("FICTA_SECRET_SHAPES_ENABLED", "0");
    const engine = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [secretShapesPlugin],
      config: engineConfigFromEnv(),
    });
    const secret = ["9b07e2fa", "d4518c36", "a28f04de", "65cb1937", "f0a2e8dc"].join(""); // synthetic opaque hex
    const body = JSON.stringify({ content: `key ${secret}` });

    vi.stubEnv("FICTA_SECRET_SHAPES_ENABLED", "1");
    // Positive control: an engine built now does detect it.
    const fresh = new ProtectionEngine({
      allowEphemeralKey: true,
      plugins: [secretShapesPlugin],
      config: engineConfigFromEnv(),
    });
    expect((await fresh.redactBodyDetailed(body)).body).not.toContain(secret);
    expect((await engine.redactBodyDetailed(body)).body).toContain(secret);
  });
});

describe("engineConfigFromEnv", () => {
  it("matches the engine defaults for an empty environment", () => {
    expect(engineConfigFromEnv({})).toEqual(resolveEngineConfig());
  });

  it("maps every engine-relevant env var", () => {
    const config = engineConfigFromEnv({
      FICTA_SURROGATE_KEY: KEY_A,
      FICTA_SURROGATE_STYLE: "typed",
      FICTA_FAIL_CLOSED_DETECTION: "1",
      FICTA_PII_ENABLED: "yes",
      FICTA_PII_FAIL_CLOSED: "0",
      FICTA_PII_BACKENDS: "Presidio, openmed",
      FICTA_PII_PRESIDIO_URL: "http://presidio.local:5002/",
      FICTA_PII_PRESIDIO_ENTITIES: "PERSON,EMAIL_ADDRESS",
      FICTA_PII_OPENMED_TIMEOUT_MS: "900",
      FICTA_SECRET_SHAPES_ENABLED: "off",
      FICTA_RESTORE_INTO_TOOLS: "none",
      FICTA_REDACT_PATHS: "1",
      FICTA_REGISTRY_EXCLUDE_NAMES: "BUILD_ID,CI",
      FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES: "LOCAL_PORT",
    });
    expect(config).toMatchObject({
      surrogate: { key: KEY_A, style: "typed" },
      detection: { failClosed: true },
      pii: {
        enabled: true,
        failClosed: false,
        backends: ["presidio", "openmed"],
        presidio: { url: "http://presidio.local:5002", entities: ["PERSON", "EMAIL_ADDRESS"] },
        openmed: { timeoutMs: 900 },
      },
      secretShapes: { enabled: false },
      restore: { intoTools: "none" },
      redactPaths: true,
      registry: { excludeNames: ["BUILD_ID", "CI"], projectExcludeNames: ["LOCAL_PORT"] },
    });
  });
});

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
