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
  "FICTA_PII_BACKENDS",
  "FICTA_PII_FAIL_CLOSED",
  "FICTA_PII_PRESIDIO_URL",
  "FICTA_PII_OPENMED_URL",
  "FICTA_SECRET_SHAPES_ENABLED",
  "FICTA_SURROGATE_STYLE",
  "FICTA_RESTORE_INTO_TOOLS",
  "FICTA_ALLOW_CUSTOM_UPSTREAM",
  "FICTA_DESTROY_CATEGORIES",
  "FICTA_DESTROY_LABELS",
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
    traceAudit: false,
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
      piiBackends: ["presidio", "openmed"],
      piiFailClosed: true,
      piiPresidioUrl: "http://127.0.0.1:5002/",
      piiOpenmedUrl: "http://127.0.0.1:5004/",
      secretShapesEnabled: true,
      surrogateStyle: "typed",
      restoreIntoTools: "all",
      allowCustomUpstream: true,
    });

    expect(result.ok).toBe(true);
    expect(readUserConfig(path)).toMatchObject({
      FICTA_FAIL_CLOSED: "0",
      FICTA_PII_ENABLED: "1",
      FICTA_PII_BACKENDS: "presidio,openmed",
      FICTA_PII_FAIL_CLOSED: "1",
      FICTA_PII_PRESIDIO_URL: "http://127.0.0.1:5002",
      FICTA_PII_OPENMED_URL: "http://127.0.0.1:5004",
      FICTA_SECRET_SHAPES_ENABLED: "1",
      FICTA_SURROGATE_STYLE: "typed",
      FICTA_RESTORE_INTO_TOOLS: "all",
      FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
    });
    expect(readFileSync(path, "utf8")).toContain('restore_into_tools = "all"');
    expect(result.ok && result.edit.restartRequired).toBe(true);
    expect(result.ok && result.edit.values.failClosed).toBe(false);
  });

  it("reads legacy single-backend config when no backend set is configured", () => {
    const path = tempConfigPath();
    process.env.FICTA_CONFIG_FILE = path;
    writeUserConfig({ FICTA_PII_BACKEND: "presidio" }, path);

    const state = proxyConfigEditState(cfg());

    expect(state.values.piiBackends).toEqual(["presidio"]);
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

    expect(applyProxyConfigPatch(cfg(), { piiBackends: ["other"] })).toMatchObject({
      ok: false,
      status: "invalid_patch",
      field: "piiBackends",
    });
    expect(applyProxyConfigPatch(cfg(), { unknown: true })).toMatchObject({
      ok: false,
      status: "invalid_patch",
    });
  });

  it("defaults an empty backend patch to regex", () => {
    const path = tempConfigPath();
    process.env.FICTA_CONFIG_FILE = path;

    const result = applyProxyConfigPatch(cfg(), { piiBackends: [] });

    expect(result.ok).toBe(true);
    expect(readUserConfig(path)).toMatchObject({ FICTA_PII_BACKENDS: "regex" });
    expect(result.ok && result.edit.values.piiBackends).toEqual(["regex"]);
  });

  describe("destroyCategories", () => {
    it("reports destroy off when nothing is configured", () => {
      process.env.FICTA_CONFIG_FILE = tempConfigPath();

      const state = proxyConfigEditState(cfg());

      expect(state.values.destroyCategories).toEqual([]);
      expect(state.locked.destroyCategories).toBeUndefined();
      expect(state.restartRequired).toBe(false);
    });

    it("writes normalized categories to config.toml and requires a restart", () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;

      const result = applyProxyConfigPatch(cfg(), {
        destroyCategories: ["Credit_Card", " za-id-number ", "credit-card"],
      });

      expect(result.ok).toBe(true);
      expect(readUserConfig(path)).toMatchObject({ FICTA_DESTROY_CATEGORIES: "credit-card,za-id-number" });
      expect(readFileSync(path, "utf8")).toContain(
        '[dispositions.destroy]\ncategories = ["credit-card", "za-id-number"]',
      );
      expect(result.ok && result.edit.values.destroyCategories).toEqual(["credit-card", "za-id-number"]);
      expect(result.ok && result.edit.restartRequired).toBe(true);
    });

    it("saves an empty list as destroy off, distinct from the running policy", () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;
      process.env.FICTA_DESTROY_CATEGORIES = "credit-card"; // running policy
      // Loaded from config.toml in the real proxy, so not an environment lock.
      writeUserConfig({ FICTA_DESTROY_CATEGORIES: "credit-card" }, path);
      const locked = {};

      const result = applyProxyConfigPatch(cfg(), { destroyCategories: [] }, locked);

      expect(result.ok).toBe(true);
      expect(readUserConfig(path)).toMatchObject({ FICTA_DESTROY_CATEGORIES: "" });
      expect(result.ok && result.edit.values.destroyCategories).toEqual([]);
      expect(result.ok && result.edit.restartRequired).toBe(true);
    });

    it("treats the same categories in another order as unchanged", () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;
      process.env.FICTA_DESTROY_CATEGORIES = "za-id-number,credit-card";
      writeUserConfig({ FICTA_DESTROY_CATEGORIES: "credit-card,za-id-number" }, path);

      expect(proxyConfigEditState(cfg(), {}).restartRequired).toBe(false);
    });

    it("drops TOML labels for categories an edit stops destroying", () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;
      writeUserConfig(
        {
          FICTA_DESTROY_CATEGORIES: "credit-card,iban-code",
          FICTA_DESTROY_LABELS: JSON.stringify({ "credit-card": "[CARD]", "iban-code": "[IBAN]" }),
        },
        path,
      );

      expect(applyProxyConfigPatch(cfg(), { destroyCategories: ["iban-code"] }).ok).toBe(true);
      expect(readUserConfig(path).FICTA_DESTROY_LABELS).toBe(JSON.stringify({ "iban-code": "[IBAN]" }));

      expect(applyProxyConfigPatch(cfg(), { destroyCategories: [] }).ok).toBe(true);
      expect(readUserConfig(path).FICTA_DESTROY_LABELS).toBeUndefined();
    });

    it('rejects "*" and invalid names without echoing them', () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;

      const all = applyProxyConfigPatch(cfg(), { destroyCategories: ["*"] });
      const bad = applyProxyConfigPatch(cfg(), { destroyCategories: ["4111 1111 1111 1111"] });
      const notList = applyProxyConfigPatch(cfg(), { destroyCategories: "credit-card" });

      expect(all).toMatchObject({ ok: false, status: "invalid_patch", field: "destroyCategories" });
      expect(!all.ok && all.message).toContain('"*"');
      expect(bad).toMatchObject({ ok: false, status: "invalid_patch", field: "destroyCategories" });
      expect(!bad.ok && bad.message).not.toContain("4111");
      expect(notList).toMatchObject({ ok: false, status: "invalid_patch", field: "destroyCategories" });
      expect(readUserConfig(path)).toEqual({});
    });

    it("locks the field when FICTA_DESTROY_CATEGORIES is set in the proxy environment", () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;
      process.env.FICTA_DESTROY_CATEGORIES = "credit-card";

      const state = proxyConfigEditState(cfg());
      const result = applyProxyConfigPatch(cfg(), { destroyCategories: [] });

      expect(state.locked.destroyCategories).toContain("FICTA_DESTROY_CATEGORIES");
      expect(state.values.destroyCategories).toEqual(["credit-card"]);
      expect(result).toMatchObject({ ok: false, status: "locked", field: "destroyCategories" });
    });

    it('locks the field while config.toml destroys every category ("*")', () => {
      const path = tempConfigPath();
      process.env.FICTA_CONFIG_FILE = path;
      writeUserConfig({ FICTA_DESTROY_CATEGORIES: "*" }, path);

      const state = proxyConfigEditState(cfg(), {});
      const result = applyProxyConfigPatch(cfg(), { destroyCategories: ["credit-card"] }, {});

      expect(state.values.destroyCategories).toEqual(["*"]);
      expect(state.locked.destroyCategories).toContain('"*"');
      expect(result).toMatchObject({ ok: false, status: "locked", field: "destroyCategories" });
      expect(readUserConfig(path).FICTA_DESTROY_CATEGORIES).toBe("*");
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
