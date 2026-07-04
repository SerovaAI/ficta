// Path-skip is surface-aware: a registered value embedded in a filesystem-path-like token is
// PRESERVED on the query string and the request body (real path params like ?redirect_uri=/a/b and
// agent tool-call paths like `cd /srv/...` must survive) but REDACTED in request headers (which rarely
// carry a legitimate local path). The mechanism is the `preservePaths` flag threaded through the
// vault; the engine scope sets it per surface — headers pass false, body/query keep the default.
process.env.FICTA_CONFIG_FILE = "0";
process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
process.env.FICTA_REGISTRY_MIN_LEN = "6";
process.env.FICTA_REDACT_PATHS = "0"; // default: path-skip active (so preservePaths actually matters)

import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { Vault } from "../src/engine/vault.js";

const REGION = "eu-central-1"; // low-entropy registered value that legitimately appears in paths
const PATHY = `/Users/alice/src/acme/${REGION}-prod`; // the value embedded in a real filesystem path

describe("vault preservePaths flag (the mechanism)", () => {
  it("preserves a path-embedded value by default (redactBody)", () => {
    const vault = new Vault([{ value: REGION }]);
    const { body, count } = vault.redactBody(JSON.stringify({ cmd: `cd ${PATHY}` }));
    expect(count).toBe(0);
    expect(body).toContain(REGION);
  });

  it("redacts a path-embedded value when preservePaths=false", () => {
    const vault = new Vault([{ value: REGION }]);
    const { body, count } = vault.redactBody(JSON.stringify({ cmd: `cd ${PATHY}` }), false);
    expect(count).toBe(1);
    expect(body).not.toContain(REGION);
    expect(body).toMatch(/FICTA_[0-9a-f]{32}/);
  });

  it("redactText mirrors the flag for raw (header/query) strings", () => {
    const vault = new Vault([{ value: REGION }]);
    expect(vault.redactText(`redirect=${PATHY}`).count).toBe(0); // default: preserve
    expect(vault.redactText(`redirect=${PATHY}`, false).count).toBe(1); // redact
  });

  it("leakValues honors the flag so the fail-closed gate matches the redaction pass", () => {
    const vault = new Vault([{ value: REGION }]);
    const text = `cd ${PATHY}`;
    expect(vault.leakValues(text, true)).toEqual([]); // preserved → not a leak
    expect(vault.leakValues(text, false)).toEqual([REGION]); // not preserved → would trip the gate
  });
});

describe("engine scope applies the per-surface policy", () => {
  const engine = (): ProtectionEngine => new ProtectionEngine({ plugins: [], values: [{ value: REGION }] });

  it("body preserves a path-embedded value (agent tool calls must not be mangled)", async () => {
    const scope = engine().beginRequest();
    const red = await scope.redactBodyDetailed(JSON.stringify({ cmd: `cd ${PATHY}` }));
    expect(red.count).toBe(0);
    expect(red.leaks).toBe(0);
    expect(red.body).toContain(REGION);
  });

  it("header (preservePaths=false) redacts a path-embedded value", async () => {
    const scope = engine().beginRequest();
    const red = await scope.redactTextDetailed(`bearer ${PATHY}`, { surface: "header", preservePaths: false });
    expect(red.count).toBe(1);
    expect(red.text).not.toContain(REGION);
  });

  it("query (default preservePaths) keeps a real path intact", async () => {
    const scope = engine().beginRequest();
    const red = await scope.redactTextDetailed(`redirect=${PATHY}`, { path: "/x" });
    expect(red.count).toBe(0);
    expect(red.leaks).toBe(0);
    expect(red.text).toContain(REGION);
  });
});
