import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { applyProxyConfigPatch, isLoopbackAddress, proxyConfigEditState } from "../src/proxy-config-edit.js";
import { readUserConfig, writeUserConfig } from "../src/user-config.js";

const MANAGED_ENV = [
  "FICTA_CONFIG_FILE",
  "FICTA_FAIL_CLOSED",
  "FICTA_PII_ENABLED",
  "FICTA_PII_BACKEND",
  "FICTA_PII_FAIL_CLOSED",
  "FICTA_PII_PRESIDIO_URL",
  "FICTA_SECRET_SHAPES_ENABLED",
  "FICTA_SURROGATE_STYLE",
  "FICTA_RESTORE_INTO_TOOLS",
  "FICTA_ALLOW_CUSTOM_UPSTREAM",
] as const;

const ORIGINAL_ENV = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreams: {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
      chatgpt: "https://chatgpt.com",
    },
    forcedUpstream: undefined,
    allowCustomUpstream: false,
    logDir: "/tmp/ficta-logs",
    logLevel: "info",
    logBodies: false,
    logMaxBytes: 256 * 1024,
    failClosed: true,
    ...overrides,
  };
}

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ficta-proxy-config-edit-")), "config.toml");
}

describe("proxy config edits", () => {
  it("reports disabled editing when persistent config loading is disabled", () => {
    process.env.FICTA_CONFIG_FILE = "0";

    const state = proxyConfigEditState(cfg());
    const result = applyProxyConfigPatch(cfg(), { failClosed: false });

    expect(state.disabled).toBe(true);
    expect(result).toMatchObject({ ok: false, status: "disabled" });
  });

  it("writes validated safety settings to config.toml without mutating the running posture", () => {
    const path = tempConfigPath();
    process.env.FICTA_CONFIG_FILE = path;

    const result = applyProxyConfigPatch(cfg(), {
      failClosed: false,
      piiEnabled: true,
      piiBackend: "presidio",
      piiFailClosed: true,
      piiPresidioUrl: "http://127.0.0.1:5002/",
      secretShapesEnabled: true,
      surrogateStyle: "typed",
      restoreIntoTools: true,
      allowCustomUpstream: true,
    });

    expect(result.ok).toBe(true);
    expect(readUserConfig(path)).toMatchObject({
      FICTA_FAIL_CLOSED: "0",
      FICTA_PII_ENABLED: "1",
      FICTA_PII_BACKEND: "presidio",
      FICTA_PII_FAIL_CLOSED: "1",
      FICTA_PII_PRESIDIO_URL: "http://127.0.0.1:5002",
      FICTA_SECRET_SHAPES_ENABLED: "1",
      FICTA_SURROGATE_STYLE: "typed",
      FICTA_RESTORE_INTO_TOOLS: "1",
      FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
    });
    expect(readFileSync(path, "utf8")).toContain("restore_into_tools = true");
    expect(result.ok && result.edit.restartRequired).toBe(true);
    expect(result.ok && result.edit.values.failClosed).toBe(false);
  });

  it("locks fields that are set by the proxy environment", () => {
    const path = tempConfigPath();
    process.env.FICTA_CONFIG_FILE = path;
    process.env.FICTA_FAIL_CLOSED = "0";
    writeUserConfig({ FICTA_FAIL_CLOSED: "1" }, path);

    const state = proxyConfigEditState(cfg({ failClosed: false }));
    const result = applyProxyConfigPatch(cfg({ failClosed: false }), { failClosed: true });

    expect(state.locked.failClosed).toContain("FICTA_FAIL_CLOSED");
    expect(state.values.failClosed).toBe(false);
    expect(result).toMatchObject({ ok: false, status: "locked", field: "failClosed" });
  });

  it("rejects invalid fields and values", () => {
    process.env.FICTA_CONFIG_FILE = tempConfigPath();

    expect(applyProxyConfigPatch(cfg(), { piiBackend: "other" })).toMatchObject({
      ok: false,
      status: "invalid_patch",
      field: "piiBackend",
    });
    expect(applyProxyConfigPatch(cfg(), { unknown: true })).toMatchObject({
      ok: false,
      status: "invalid_patch",
    });
  });

  it("identifies loopback client addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.0.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
