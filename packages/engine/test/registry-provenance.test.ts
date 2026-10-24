import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin } from "../src/index.js";
import type { VaultEntry, VaultStore } from "../src/vault-store.js";

const KEY = `${"k".repeat(16)}abcdefghijklmnopqrstuvwxyz0123456789`;
const SECRET = "regsecret-7Qm2xVb9LpT4";

/** Flags the registered secret wherever it appears, as a secret-shape detector would for a real token. */
const shapeDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-shape-detector",
  detectText: (text) =>
    text.includes(SECRET)
      ? [
          {
            name: "token",
            value: SECRET,
            source: "fixture-detector",
            kind: "secret" as const,
            confidence: "high" as const,
          },
        ]
      : [],
};

function engine(vault?: VaultStore): ProtectionEngine {
  return new ProtectionEngine({
    config: { surrogate: { key: KEY } },
    plugins: [shapeDetector],
    values: [{ name: "API_TOKEN", value: SECRET, source: ".env", kind: "secret", confidence: "exact" }],
    vault,
  });
}

/** A store holding fixed rows, standing in for one written by an earlier release. */
function storeWith(entries: readonly VaultEntry[]): VaultStore {
  return {
    load: async () => entries,
    lookup: async (_scope, tokens) => entries.filter((entry) => tokens.includes(entry.token)),
    append: async () => {},
    touch: async () => {},
    prune: async () => 0,
    forget: async () => 0,
    close: async () => {},
  } as VaultStore;
}

function toolCall(token: string): string {
  return JSON.stringify({
    output: [{ type: "function_call", arguments: JSON.stringify({ cmd: `curl -H 'auth: ${token}'` }) }],
  });
}

describe("a registry secret keeps registry provenance on every surface", () => {
  for (const surface of ["header", "query"] as const) {
    it(`stays withheld from tool calls after a detector also sees it in a ${surface}`, async () => {
      const scope = engine().beginRequest();
      const text = surface === "header" ? `x-note: ${SECRET}` : `q=${SECRET}`;
      const redacted = await scope.redactTextDetailed(text, { surface, preservePaths: false });
      expect(redacted.text).not.toContain(SECRET);
      const token = redacted.text.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";
      expect(token).not.toBe("");

      const restored = scope.restoreJson(toolCall(token), "openai-responses");
      expect(restored).not.toContain(SECRET);
      expect(restored).toContain(token);
      expect(scope.withheldFromToolsCount).toBe(1);
    });
  }

  it("does not persist the registry secret into a keyed scope's detected layer", async () => {
    const eng = engine();
    const first = eng.beginRequest("org:t");
    const { text } = await first.redactTextDetailed(`x-note: ${SECRET}`, { surface: "header", preservePaths: false });
    const token = text.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";

    const next = eng.beginRequest("org:t");
    await next.redactBodyDetailed(JSON.stringify({ input: "hello" }));
    expect(next.restoreJson(toolCall(token), "openai-responses")).not.toContain(SECRET);
  });

  it("keeps a registry secret withheld when a stale store row lists it on the detected layer", async () => {
    const { text } = await engine().beginRequest().redactTextDetailed(SECRET);
    const token = text.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";
    const stale: VaultEntry = {
      type: "literal",
      layer: "detected",
      token,
      value: SECRET,
      hint: { name: "token", kind: "secret" },
      matchForm: true,
      wordBounded: false,
      tokenOnly: false,
    };
    const scope = engine(storeWith([stale])).beginRequest("org:t");
    await scope.redactBodyDetailed(JSON.stringify({ input: "hello" }));
    expect(scope.restoreJson(toolCall(token), "openai-responses")).not.toContain(SECRET);
    expect(scope.withheldFromToolsCount).toBe(1);
  });
});
