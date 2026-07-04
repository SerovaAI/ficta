import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import {
  detectSecretShapes,
  type ProtectedValue,
  resolveAgentSecretShapesEnabled,
  secretShapesPlugin,
} from "../src/plugins/index.js";

const OPENAI = ["sk", "proj", "abc123def456ghi789T3BlbkFJabcdefghijklmno"].join("-");
const GITHUB = ["ghp", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234"].join("_");
const SLACK = ["xoxb", "123456789012", "123456789012", "abcdefABCDEF"].join("-");
const STRIPE = ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30";
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCu",
  "-----END PRIVATE KEY-----",
].join("\n");
const GENERIC_SECRET = "aB3dE5fG7hJ9kLmN2pQr";

describe("secret-shape detector", () => {
  it("stays on the detector boundary, not the exact-value registry-source boundary", () => {
    expect(secretShapesPlugin.kind).toBe("detector");
    expect("loadValues" in secretShapesPlugin).toBe(false);
    expect(secretShapesPlugin.name).toBe("secret-shapes");
    expect(secretShapesPlugin.config?.sections).toEqual([{ path: ["secret_shapes"], keys: ["enabled", "agents"] }]);
  });

  it("detects known token shapes without pre-registration", () => {
    const found = detectSecretShapes(
      [`OpenAI ${OPENAI}`, `GitHub ${GITHUB}`, `Slack ${SLACK}`, `Stripe ${STRIPE}`, `JWT ${JWT}`, PRIVATE_KEY].join(
        "\n",
      ),
    );
    const values = new Set(found.map((value) => value.value));

    expect(values).toContain(OPENAI);
    expect(values).toContain(GITHUB);
    expect(values).toContain(SLACK);
    expect(values).toContain(STRIPE);
    expect(values).toContain(JWT);
    expect(values).toContain(PRIVATE_KEY);
    for (const value of found) expect(value.kind).toBe("secret");
  });

  it("detects secret-ish assignments and JSON key/value leaves", async () => {
    const assignment = detectSecretShapes(`CUSTOM_API_TOKEN=${GENERIC_SECRET}`);
    expect(assignment.map((value) => value.value)).toContain(GENERIC_SECRET);

    const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const body = JSON.stringify({ api_token: GENERIC_SECRET });
      const redacted = await engine.redactBodyDetailed(body);

      expect(redacted.count).toBe(1);
      expect(redacted.leaks).toBe(0);
      expect(redacted.body).not.toContain(GENERIC_SECRET);
      expect(engine.restoreJson(redacted.body)).toContain(GENERIC_SECRET);
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });

  it("is disabled by default and active when configured", async () => {
    delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    expect(await secretShapesPlugin.detectText(OPENAI, { surface: "body" })).toEqual([]);
    expect(secretShapesPlugin.discover?.()[0]?.status).toBe("disabled");

    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const found = (await secretShapesPlugin.detectText(OPENAI, { surface: "body" })) as ProtectedValue[];
      expect(found.map((value) => value.value)).toEqual([OPENAI]);
      expect(secretShapesPlugin.discover?.()[0]?.status).toBe("active");
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });

  it("round-trips a pasted secret through the scoped engine layer", async () => {
    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
      const scope = engine.beginRequest("org:thread");
      const body = JSON.stringify({ messages: [{ role: "user", content: `new key ${OPENAI}` }] });

      const redacted = await scope.redactBodyDetailed(body);
      expect(redacted.count).toBe(1);
      expect(redacted.leaks).toBe(0);
      expect(redacted.body).not.toContain(OPENAI);
      expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(scope.restoreJson(redacted.body)).toContain(OPENAI);
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });
});

describe("resolveAgentSecretShapesEnabled", () => {
  it("is off for agents unless both enabled and agents are true", () => {
    expect(resolveAgentSecretShapesEnabled({})).toBe(false);
    expect(resolveAgentSecretShapesEnabled({ enabled: "1" })).toBe(false);
    expect(resolveAgentSecretShapesEnabled({ enabled: "1", agents: "1" })).toBe(true);
  });

  it("lets an explicit shell value win", () => {
    expect(resolveAgentSecretShapesEnabled({ shellValue: "1", enabled: "0", agents: "0" })).toBe(true);
    expect(resolveAgentSecretShapesEnabled({ shellValue: "0", enabled: "1", agents: "1" })).toBe(false);
  });
});
