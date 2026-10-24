import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import { surrogateStrategy } from "../src/surrogate.js";
import { Vault } from "../src/vault.js";

const KEY = `${"k".repeat(16)}abcdefghijklmnopqrstuvwxyz0123456789`;
const SECRET = "regsecret-W8nQ3vKz5Lp";
// A 32-hex API key: the exact shape of an opaque surrogate's tail.
const HEX_KEY = ["0123456789abcdef", "fedcba9876543210"].join("");
const TOKEN = /FICTA_[0-9a-f]{32}/;

function engine(values: string[] = [SECRET]): ProtectionEngine {
  return new ProtectionEngine({
    config: { surrogate: { key: KEY }, detectors: { secretShapes: false, pii: false } },
    plugins: [],
    values: values.map((value, i) => ({
      name: `SECRET_${i}`,
      value,
      source: ".env",
      kind: "secret" as const,
      confidence: "exact" as const,
    })),
  });
}

describe("the body is scanned and forwarded literal by literal", () => {
  it("redacts a value hidden behind a duplicate key", async () => {
    const body = `{"messages":[{"role":"user","content":"${SECRET}","content":"hello"}]}`;
    const result = await engine().beginRequest().redactBodyDetailed(body);
    expect(result.body).not.toContain(SECRET);
    expect(result.count).toBe(1);
    expect(result.leaks).toBe(0);
    // Both keys survive: the forwarded bytes are the client's, with the hidden value replaced.
    expect(result.body).toMatch(
      /^\{"messages":\[\{"role":"user","content":"FICTA_[0-9a-f]{32}","content":"hello"\}\]\}$/,
    );
  });

  it("the leak gate sees a value hidden behind a duplicate key", () => {
    const vault = new Vault([{ value: SECRET }], surrogateStrategy({ key: KEY }));
    expect(vault.leakValues(`{"content":"${SECRET}","content":"hello"}`)).toEqual([SECRET]);
  });

  it("keeps large integers and formatting when something else is redacted", async () => {
    const body = `{\n  "id": 1234567890123456789,\n  "ratio": 1.50,\n  "content": "use ${SECRET}"\n}`;
    const result = await engine().beginRequest().redactBodyDetailed(body);
    expect(result.body.replace(TOKEN, "TOKEN")).toBe(
      `{\n  "id": 1234567890123456789,\n  "ratio": 1.50,\n  "content": "use TOKEN"\n}`,
    );
  });

  it("forwards a body with nothing to redact byte for byte", async () => {
    const body = `{"a": 1e400, "b": "\\u00e9", "a": 2}`;
    expect((await engine().beginRequest().redactBodyDetailed(body)).body).toBe(body);
  });
});

describe("only minted tokens shield the text inside them", () => {
  it("redacts a 32-hex secret written as a made-up token", async () => {
    const result = await engine([HEX_KEY])
      .beginRequest()
      .redactBodyDetailed(JSON.stringify({ content: `key FICTA_${HEX_KEY}` }));
    expect(result.body).not.toContain(HEX_KEY);
    expect(result.leaks).toBe(0);
  });

  it("redacts a longer secret that starts inside a made-up token", async () => {
    const long = `${HEX_KEY}a1b2c3d4`;
    const result = await engine([long])
      .beginRequest()
      .redactBodyDetailed(JSON.stringify({ content: `FICTA_${long}` }));
    expect(result.body).not.toContain(long);
  });

  it("the leak gate catches a secret inside a made-up token", () => {
    const vault = new Vault([{ value: HEX_KEY }], surrogateStrategy({ key: KEY }));
    expect(vault.leakValues(JSON.stringify({ content: `FICTA_${HEX_KEY}` }))).toEqual([HEX_KEY]);
  });

  it("redacts it on the header surface too", async () => {
    const result = await engine([HEX_KEY]).beginRequest().redactTextDetailed(`x-dbg: FICTA_${HEX_KEY}`, {
      surface: "header",
      preservePaths: false,
    });
    expect(result.text).not.toContain(HEX_KEY);
    expect(result.leaks).toBe(0);
  });

  it("still exempts a value that sits inside this scope's own token", async () => {
    const scope = engine([SECRET, "FICTA"]).beginRequest();
    const first = await scope.redactBodyDetailed(JSON.stringify({ content: `use ${SECRET}` }));
    const token = first.body.match(TOKEN)?.[0] ?? "";
    const again = await scope.redactBodyDetailed(JSON.stringify({ content: `the model said ${token}` }));
    expect(again.leaks).toBe(0);
    expect(again.body).toContain(token);
  });
});
