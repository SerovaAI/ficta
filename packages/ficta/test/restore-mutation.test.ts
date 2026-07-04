// Characterization tests for what happens when a model returns a MUTATED surrogate.
//
// Restore is exact string match (vault.ts `restoreTextExcept`): a token that matches the surrogate
// shape but is not in the dictionary is returned UNCHANGED, and a token whose shape is broken is not
// matched at all. Either way it is passed through — never fuzzily mapped to a value. These tests pin
// that behavior so a future residual-surrogate guard (see notes/spec-restore-mutation-hardening.md,
// Part B) is an intentional change, not an accidental one. The load-bearing invariant is the safety
// one: a mutated surrogate must NEVER restore to the real secret.

import { afterEach, describe, expect, it } from "vitest";
import { typedSurrogateStrategy } from "../src/engine/surrogate.js";
import { Vault } from "../src/engine/vault.js";
import { sseRestoreAdapterFor } from "../src/engine/wire-restore.js";

const KEY = "test-surrogate-key-at-least-32-bytes-long!!";
const SECRET = "corova-control-plane";
const SURROGATE_SHAPE = /FICTA_[0-9a-f]{32}/;

// --- mutations that BREAK the token (shape no longer matches → never restored) -------------------
const upperTail = (s: string): string => s.slice(0, -32) + s.slice(-32).toUpperCase();
const lowerPrefix = (s: string): string => s.replace(/^FICTA_/, "ficta_");
const dropChar = (s: string): string => s.slice(0, -1);
const spaceMid = (s: string): string => {
  const i = s.length - 16;
  return `${s.slice(0, i)} ${s.slice(i)}`;
};
// --- mutation that keeps a VALID shape but an unknown value (the "residual" case) -----------------
const flipLastHex = (s: string): string => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");

const BREAKERS: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ["uppercased hex tail", upperTail],
  ["lowercased FICTA_ prefix", lowerPrefix],
  ["one char dropped", dropChar],
  ["whitespace injected mid-token", spaceMid],
];

function opaqueVault(): { vault: Vault; surrogate: string } {
  const vault = new Vault([{ value: SECRET }]);
  return { vault, surrogate: vault.redactText(SECRET).text };
}

describe("restore hardening — mutated surrogate never yields the real secret (restoreText)", () => {
  afterEach(() => {
    delete process.env.FICTA_RESTORE_INTO_TOOLS;
  });

  it("restores a byte-intact token (baseline)", () => {
    const { vault, surrogate } = opaqueVault();
    expect(vault.restoreText(surrogate)).toBe(SECRET);
  });

  for (const [label, mutate] of BREAKERS) {
    it(`does not restore a token with ${label}, and never leaks the secret`, () => {
      const { vault, surrogate } = opaqueVault();
      const mutated = mutate(surrogate);
      const out = vault.restoreText(mutated);
      expect(out).not.toContain(SECRET); // the safety invariant
      expect(out).toBe(mutated); // characterization: broken token passes through untouched
    });
  }

  it("passes a shape-valid but unknown token through unchanged (the residual case Part B targets)", () => {
    const { vault, surrogate } = opaqueVault();
    const residual = flipLastHex(surrogate);
    const out = vault.restoreText(residual);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(residual); // TODAY: silently forwarded. Part B's guard should flag/strip this.
    expect(out).toMatch(SURROGATE_SHAPE); // still looks like a real token to a downstream reader
  });

  it("still restores a byte-intact token adjacent to punctuation/junk (no over-strictness)", () => {
    const { vault, surrogate } = opaqueVault();
    expect(vault.restoreText(`\`${surrogate}\``)).toContain(SECRET); // backtick-wrapped
    expect(vault.restoreText(`${surrogate} done`)).toContain(SECRET); // trailing junk
  });
});

describe("restore hardening — mutated surrogate in a stream (restoreStream)", () => {
  it("reassembles an intact surrogate split across chunks (baseline regression)", async () => {
    const { vault, surrogate } = opaqueVault();
    const text = `data: {"t":"${surrogate}"}\n\n`;
    const cut = text.indexOf(surrogate) + 8;
    const out = await transformText(vault.restoreStream(), [text.slice(0, cut), text.slice(cut)]);
    expect(out).toContain(SECRET);
    expect(out).not.toContain(surrogate);
  });

  it("does not restore a residual token split across chunks, and never leaks the secret", async () => {
    const { vault, surrogate } = opaqueVault();
    const residual = flipLastHex(surrogate);
    const text = `data: {"t":"${residual}"}\n\n`;
    const cut = text.indexOf(residual) + 8;
    const out = await transformText(vault.restoreStream(), [text.slice(0, cut), text.slice(cut)]);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("FICTA_"); // residual survives to the client today
  });

  it("does not leak the secret when a token is truncated at the end of the stream", async () => {
    const { vault, surrogate } = opaqueVault();
    const out = await transformText(vault.restoreStream(), [`prefix ${dropChar(surrogate)}`]);
    expect(out).not.toContain(SECRET);
  });
});

describe("restore hardening — mutated surrogate in SSE across every wire (restoreEventStream)", () => {
  for (const wire of ["anthropic", "openai-chat", "openai-responses", "unknown"] as const) {
    it(`never restores a residual token to the secret on the ${wire} wire`, async () => {
      const { vault, surrogate } = opaqueVault();
      const residual = flipLastHex(surrogate);
      const sse = `data: ${JSON.stringify({ m: `see ${residual}` })}\n\n`;
      const out = await transformText(vault.restoreEventStream(sseRestoreAdapterFor(wire)), [sse]);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("FICTA_"); // the residual passes through; the real value never does
    });
  }
});

describe("restore hardening — typed surrogates (FICTA_TYPE_<hex>)", () => {
  const SSN = "123-45-6789";
  const typedVault = (): { vault: Vault; surrogate: string } => {
    const vault = new Vault([{ value: SSN, name: "us-ssn", kind: "pii" }], typedSurrogateStrategy(KEY));
    return { vault, surrogate: vault.redactText(SSN).text };
  };

  it("mints a typed token and restores it byte-intact", () => {
    const { vault, surrogate } = typedVault();
    expect(surrogate).toMatch(/^FICTA_SSN_[0-9a-f]{32}$/);
    expect(vault.restoreText(surrogate)).toBe(SSN);
  });

  it("reassembles an intact typed token split across chunks (exercises the larger HOLD tail)", async () => {
    const { vault, surrogate } = typedVault();
    const text = `data: {"t":"${surrogate}"}\n\n`;
    const cut = text.indexOf(surrogate) + 10; // mid typed token
    const out = await transformText(vault.restoreStream(), [text.slice(0, cut), text.slice(cut)]);
    expect(out).toContain(SSN);
    expect(out).not.toContain(surrogate);
  });

  it("does not restore a mutated typed token, and never leaks the secret", () => {
    const { vault, surrogate } = typedVault();
    for (const mutate of [flipLastHex, upperTail, dropChar]) {
      const out = vault.restoreText(mutate(surrogate));
      expect(out).not.toContain(SSN);
    }
  });
});

// --- local helper (mirrors test/vault.test.ts) ---------------------------------------------------
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
