// Residual-surrogate guard, Phase 1 (observe/count) — notes/spec-restore-mutation-hardening.md Part B.
//
// A surrogate-shaped token that survives restore with no dictionary mapping is a known restore
// failure: the model mutated, truncated, or invented it (live evidence 2026-07-15: a model narrating
// about entity-token families wrote `FICTA_ORG_<entityTag>_*`). Phase 1 counts that debris per view
// without changing a single response byte — restore-mutation.test.ts keeps pinning the pass-through
// behavior; this file pins the observability on top of it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  entityFamilySurrogateStrategy,
  hexSurrogateStrategy,
  typedSurrogateStrategy,
} from "../src/engine/surrogate.js";
import { Vault } from "../src/engine/vault.js";
import { sseRestoreAdapterFor } from "../src/engine/wire-restore.js";
import { ProtectionStats, renderProtectionStatsSummary } from "../src/protection-stats.js";

const KEY = "residual-guard-test-key-at-least-32-bytes!";
const CONTEXT = "thread:residual-guard";
const SECRET = "corova-control-plane";
const ENTITY_TAG = "ABCDEFGH2345"; // 12 chars from the base32 alphabet (A-Z2-7)

const flipLastHex = (s: string): string => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");

function opaqueVault(): { vault: Vault; surrogate: string } {
  const vault = new Vault([{ value: SECRET }]);
  return { vault, surrogate: vault.redactText(SECRET).text };
}

function entityScope() {
  const vault = new Vault([], entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY));
  const scope = vault.beginScope(undefined, undefined, CONTEXT);
  const token = scope.registerResolvedEntitySurface(
    { value: "Northstar Biologics", entityId: "entity-northstar", entityType: "organization" },
    "registry",
    true,
  );
  return { scope, token };
}

describe("residual guard — buffered restoreText", () => {
  it("counts a shape-valid unknown token and forwards it unchanged", () => {
    const { vault, surrogate } = opaqueVault();
    const residual = flipLastHex(surrogate);
    const out = vault.restoreText(`before ${residual} after`);
    expect(out).toBe(`before ${residual} after`); // Phase 1: observe only, bytes unchanged
    expect(vault.residualSurrogateCount).toBe(1);
    expect(vault.residualSurrogates.has(residual)).toBe(true);
  });

  it("does not count a known token that restores", () => {
    const { vault, surrogate } = opaqueVault();
    expect(vault.restoreText(surrogate)).toBe(SECRET);
    expect(vault.residualSurrogateCount).toBe(0);
  });

  it("counts an unknown typed token regardless of the active style", () => {
    const { vault } = opaqueVault(); // opaque style active; typed-shaped debris still observed
    const typed = typedSurrogateStrategy(KEY).mint("555-11-2222", { name: "us-ssn", kind: "pii" });
    vault.restoreText(`the ${typed} patient`);
    expect(vault.residualSurrogateCount).toBe(1);
  });

  it("counts the observed wildcard entity-family reference (the 2026-07-15 live case)", () => {
    const { vault } = opaqueVault();
    vault.restoreText(`multiple FICTA_ORG_${ENTITY_TAG}_* tokens refer to the client`);
    expect(vault.residualSurrogateCount).toBe(1);
    expect(vault.residualSurrogates.has(`FICTA_ORG_${ENTITY_TAG}_`)).toBe(true);
  });

  it("counts a bare entity-tag reference ending at a word boundary", () => {
    const { vault } = opaqueVault();
    vault.restoreText(`the FICTA_PERSON_${ENTITY_TAG} family`);
    expect(vault.residualSurrogateCount).toBe(1);
  });

  it("counts a complete unknown entity token exactly once, never as its own fragment", () => {
    const { vault } = opaqueVault();
    vault.restoreText(`see FICTA_ORG_${ENTITY_TAG}_${ENTITY_TAG} here`);
    expect(vault.residualSurrogateCount).toBe(1);
    expect(vault.residualSurrogates.has(`FICTA_ORG_${ENTITY_TAG}_${ENTITY_TAG}`)).toBe(true);
  });

  it("ignores prose that only mentions the token prefix or a partial tag", () => {
    const { vault } = opaqueVault();
    vault.restoreText("tokens start with FICTA_ORG_ and FICTA_ or FICTA_ORG_ABC in docs");
    expect(vault.residualSurrogateCount).toBe(0);
  });

  it("does not count a known token deliberately left in place (tool-arg withholding skip)", () => {
    const { vault, surrogate } = opaqueVault();
    const body = JSON.stringify({ arguments: `use ${surrogate}` });
    const out = vault.restoreJsonText(body, new Set([surrogate]));
    expect(out).toContain(surrogate); // placeholder kept by design
    expect(vault.residualSurrogateCount).toBe(0); // mapped token → not residual
  });

  it("observes debris even when the vault holds no surrogates at all", () => {
    const vault = new Vault([]);
    vault.restoreText(`echoed FICTA_${"0".repeat(31)}1 from an older session`);
    expect(vault.residualSurrogateCount).toBe(1);
  });
});

describe("residual guard — restoreStream", () => {
  it("counts a residual token split across chunk boundaries exactly once", async () => {
    const { vault, surrogate } = opaqueVault();
    const residual = flipLastHex(surrogate);
    const text = `data: {"t":"${residual}"}\n\n`;
    const cut = text.indexOf(residual) + 8;
    const out = await transformText(vault.restoreStream(), [text.slice(0, cut), text.slice(cut)]);
    expect(out).toContain(residual);
    expect(vault.residualSurrogateCount).toBe(1);
    expect(vault.residualSurrogates.has(residual)).toBe(true);
  });

  it("does not flag a KNOWN entity token split mid-surface-tag (fragment false-positive guard)", async () => {
    const { scope, token } = entityScope();
    const text = `pad ${token} pad`;
    const cut = text.indexOf(token) + token.length - 5; // split inside the surface tag
    const out = await transformText(scope.restoreStream(), [text.slice(0, cut), text.slice(cut)]);
    expect(out).toContain("Northstar Biologics");
    expect(scope.residualSurrogateCount).toBe(0);
  });

  it("counts a wildcard fragment whose right context arrives in the next chunk", async () => {
    const { vault } = opaqueVault();
    const chunks = [`families: FICTA_ORG_${ENTITY_TAG}_`, `* and FICTA_ORG_${ENTITY_TAG}_* again`];
    await transformText(vault.restoreStream(), chunks);
    expect(vault.residualSurrogateCount).toBe(1); // same fragment token, deduplicated
  });

  it("counts a token truncated by the end of the stream", async () => {
    const { vault } = opaqueVault();
    await transformText(vault.restoreStream(), [`tail FICTA_ORG_${ENTITY_TAG}_`]);
    expect(vault.residualSurrogateCount).toBe(1);
  });
});

describe("residual guard — restoreEventStream", () => {
  for (const wire of ["anthropic", "openai-chat", "openai-responses", "unknown"] as const) {
    it(`counts a residual token on the ${wire} wire`, async () => {
      const { vault, surrogate } = opaqueVault();
      const residual = flipLastHex(surrogate);
      const sse = `data: ${JSON.stringify({ m: `see ${residual}` })}\n\n`;
      const out = await transformText(vault.restoreEventStream(sseRestoreAdapterFor(wire)), [sse]);
      expect(out).toContain(residual);
      expect(vault.residualSurrogateCount).toBe(1);
    });
  }

  it("counts a residual stitched from fragments split across openai-chat delta events", async () => {
    const { vault, surrogate } = opaqueVault();
    const residual = flipLastHex(surrogate);
    const head = residual.slice(0, 12);
    const tail = residual.slice(12);
    const events =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `see ${head}` } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${tail} ok` } }] })}\n\n` +
      "data: [DONE]\n\n";
    await transformText(vault.restoreEventStream(sseRestoreAdapterFor("openai-chat")), [events]);
    expect(vault.residualSurrogateCount).toBe(1);
    expect(vault.residualSurrogates.has(residual)).toBe(true);
  });

  it("does not count a known token that restores on the wire", async () => {
    const { vault, surrogate } = opaqueVault();
    const sse = `data: ${JSON.stringify({ m: `see ${surrogate}` })}\n\n`;
    const out = await transformText(vault.restoreEventStream(sseRestoreAdapterFor("unknown")), [sse]);
    expect(out).toContain(SECRET);
    expect(vault.residualSurrogateCount).toBe(0);
  });
});

describe("residual guard — protection stats", () => {
  it("accumulates residual counts into totals and renders the summary line", () => {
    const stats = new ProtectionStats(join(mkdtempSync(join(tmpdir(), "ficta-residual-")), "stats.json"));
    // The summary renderer stays quiet on a session with zero redaction events; give it one.
    stats.record({
      method: "POST",
      path: "/v1/messages",
      wire: "anthropic",
      surface: "body",
      redactedValues: 1,
      survivingValues: 0,
      blocked: false,
    });
    stats.recordRestore({ restoredValues: 2, withheldFromToolsValues: 0, residualSurrogateValues: 3 });
    stats.recordRestore({ restoredValues: 0, withheldFromToolsValues: 0, residualSurrogateValues: 1 });
    const snapshot = stats.snapshot();
    expect(snapshot.totals.residualSurrogateValues).toBe(4);
    expect(renderProtectionStatsSummary(snapshot)).toContain("unrestored surrogate tokens: 4");
  });

  it("records a residual-only outcome even with zero restores", () => {
    const stats = new ProtectionStats(join(mkdtempSync(join(tmpdir(), "ficta-residual-")), "stats.json"));
    stats.recordRestore({ restoredValues: 0, withheldFromToolsValues: 0, residualSurrogateValues: 2 });
    expect(stats.residualSurrogateValues).toBe(2);
  });
});

// --- local helper (mirrors test/restore-mutation.test.ts) -----------------------------------------
async function transformText(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]): Promise<string> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let out = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  await pump;
  return out;
}
