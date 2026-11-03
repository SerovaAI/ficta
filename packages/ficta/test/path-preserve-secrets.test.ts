import { describe, expect, it } from "vitest";
import { modelVisibleText, ProtectionEngine } from "@serovaai/ficta-engine";
import { secretShapesPlugin } from "../src/plugins/index.js";
import { engineConfigFromEnv } from "../src/engine-env.js";

// Synthetic values assembled to keep complete credential-like strings out of source fixtures.
const HEX = ["5f3c9a1e", "7b2d4f60", "8e1a3c5b", "9d7f2e4a", "6c0b8d1f"].join("");
const TOKEN = ["Zx9Qw8Vt", "7Lm6Pk3J", "Hj4Np2Rd", "5Wb0Ty1F"].join("");
const REGION = "eu-central-1-prod";

function scopeWith(name: string, values: readonly string[]) {
  const engine = new ProtectionEngine({
    allowEphemeralKey: true,
    plugins: [secretShapesPlugin],
    config: engineConfigFromEnv(),
  });
  const scope = engine.beginRequest(name);
  scope.registerProtectedValues(values.map((value, i) => ({ name: `SECRET_${i}`, value, source: "test" })));
  return scope;
}

async function sent(name: string, values: readonly string[], content: string): Promise<string> {
  const result = await scopeWith(name, values).redactBodyDetailed(
    JSON.stringify({ messages: [{ role: "assistant", content }] }),
  );
  return JSON.parse(result.body).messages[0].content as string;
}

describe("path preservation never keeps credential-looking values", () => {
  it.each([
    ["git revision range", `git log --oneline ${HEX}..origin/main -- src/a.ts`],
    ["git error output", `fatal: bad revision '${HEX}..origin/main'`],
    ["host path", `curl api.example.test/v1/${TOKEN}/items`],
    ["relative path", `cat cache/${TOKEN}.json`],
    ["absolute path", `ls /tmp/${HEX}/out`],
    ["cd target", `cd /srv/${TOKEN}`],
  ])("replaces a known value in a %s", async (_label, content) => {
    const value = content.includes(HEX) ? HEX : TOKEN;
    const out = await sent(`credential-${_label}`, [value], content);
    expect(out).not.toContain(value);
  });

  it("still leaves plain names usable inside paths", async () => {
    const out = await sent("plain-name", [REGION], `cd /Users/me/src/serova/${REGION} && ls ../${REGION}/k8s`);
    expect(out).toBe(`cd /Users/me/src/serova/${REGION} && ls ../${REGION}/k8s`);
  });
});

describe("modelVisibleText", () => {
  it("drops top-level fields the model never sees", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-5-5",
      metadata: { user_id: "FICTA_hidden" },
      user: "FICTA_user",
      messages: [{ role: "user", content: "FICTA_seen" }],
    });
    const visible = modelVisibleText(body);
    expect(visible).toContain("FICTA_seen");
    expect(visible).not.toContain("FICTA_hidden");
    expect(visible).not.toContain("FICTA_user");
  });

  it("keeps a nested metadata field and returns non-JSON unchanged", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "x", metadata: { id: "FICTA_nested" } }] });
    expect(modelVisibleText(body)).toContain("FICTA_nested");
    expect(modelVisibleText("not json FICTA_x")).toBe("not json FICTA_x");
  });
});
