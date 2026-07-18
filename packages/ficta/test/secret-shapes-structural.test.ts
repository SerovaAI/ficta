import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { type BodyLeaf, visitBodyLeaves } from "../src/engine/vault.js";
import { detectSecretShapeLeaves, secretShapesPlugin } from "../src/plugins/index.js";

// Secret-ish test values assembled at runtime so the source file never contains a contiguous
// secret-shaped literal (mirrors the OPENAI/GITHUB style in secret-shapes.test.ts).
const SECRET_A = ["Zx9", "Qw8", "Vt7", "Lm6", "Pk3qJ"].join("-");
const SECRET_B = ["Hj4", "Np2", "Rd5", "Wb8", "Ty9wF"].join("-");

function bodyLeavesOf(value: unknown): BodyLeaf[] {
  const leaves: BodyLeaf[] = [];
  visitBodyLeaves(value, (leaf) => {
    leaves.push(leaf);
  });
  return leaves;
}

async function redactWithDetector(body: string) {
  process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
  try {
    const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
    return { engine, redacted: await engine.redactBodyDetailed(body) };
  } finally {
    delete process.env.FICTA_SECRET_SHAPES_ENABLED;
  }
}

describe("structural secret-json-value detection", () => {
  it("pairs a secret-ish key with its own string value", () => {
    const found = detectSecretShapeLeaves(bodyLeavesOf({ api_token: SECRET_A }));
    expect(found.map((value) => value.value)).toEqual([SECRET_A]);
    expect(found[0]?.name).toBe("secret-json-value");
  });

  it("pairs a secret-ish key with the string elements of its direct array value", () => {
    const found = detectSecretShapeLeaves(bodyLeavesOf({ api_keys: [SECRET_A, SECRET_B] }));
    expect(found.map((value) => value.value)).toEqual([SECRET_A, SECRET_B]);
  });

  it("pairs a nested secret-ish key with its value", () => {
    const found = detectSecretShapeLeaves(bodyLeavesOf({ config: { client_secret: SECRET_A } }));
    expect(found.map((value) => value.value)).toEqual([SECRET_A]);
  });

  it("never treats a following object key as the value of a non-string-valued key", () => {
    // The Fable 5 request shape: max_tokens (numeric — emits no leaf) directly before
    // output_config. The old joined-text regex captured the protocol key as a "secret".
    expect(detectSecretShapeLeaves(bodyLeavesOf({ max_tokens: 64000, output_config: { effort: "high" } }))).toEqual([]);
    expect(detectSecretShapeLeaves(bodyLeavesOf({ api_token: { nested: "irrelevant" } }))).toEqual([]);
  });

  it("takes only the leading token of a value, like the assignment patterns", () => {
    const found = detectSecretShapeLeaves(bodyLeavesOf({ client_secret: `${SECRET_A} trailing words` }));
    expect(found.map((value) => value.value)).toEqual([SECRET_A]);
  });
});

describe("protocol keys survive body redaction (Fable 5 regression)", () => {
  it("forwards a body with max_tokens adjacent to output_config byte-identically", async () => {
    const body = JSON.stringify({
      model: "claude-fable-5",
      max_tokens: 64000,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "search the web for ficta" }],
    });
    const { engine, redacted } = await redactWithDetector(body);
    expect(redacted.body).toBe(body);
    expect(redacted.count).toBe(0);

    // The vault must not be poisoned for later requests through the same engine either.
    const followup = JSON.stringify({ max_tokens: 64000, output_config: { effort: "high" } });
    expect((await engine.redactBodyDetailed(followup)).body).toBe(followup);
  });

  it("does not capture a key after a content string ending in a secret-ish word", async () => {
    const body = JSON.stringify({
      system: "always use the auth token",
      output_config: { effort: "high" },
    });
    const { redacted } = await redactWithDetector(body);
    expect(redacted.body).toBe(body);
  });

  it("does not let an assignment match cross from a content string into the next key", async () => {
    // "auth:" at the end of a string leaf once let the assignment pattern consume the following
    // object key as its value across the leaf boundary.
    const body = JSON.stringify({
      note: "set the auth:",
      output_config: { effort: "high" },
    });
    const { redacted } = await redactWithDetector(body);
    expect(redacted.body).toBe(body);
  });

  it("still redacts a real secret under a secret-ish key end to end", async () => {
    const body = JSON.stringify({ api_keys: [SECRET_A, SECRET_B], max_tokens: 64000 });
    const { engine, redacted } = await redactWithDetector(body);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(SECRET_A);
    expect(redacted.body).not.toContain(SECRET_B);
    expect(redacted.body).toContain("max_tokens");
    const restored = engine.restoreJson(redacted.body);
    expect(restored).toContain(SECRET_A);
    expect(restored).toContain(SECRET_B);
  });

  it("still detects key/value lines inside one multi-line string leaf", async () => {
    const body = JSON.stringify({ content: `API_TOKEN\n${SECRET_A}` });
    const { redacted } = await redactWithDetector(body);
    expect(redacted.body).not.toContain(SECRET_A);
  });
});
