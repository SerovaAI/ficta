import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hexSurrogateStrategy } from "@serovaai/ficta-engine";
import { engineConfigFromEnv } from "../src/engine-env.js";
import { startProxy } from "../src/server.js";
import {
  checkSurrogateKey,
  ensureSurrogateKey,
  readSurrogateKeyFile,
  readUserConfig,
  resetUserConfigForTests,
  resolveSurrogateKey,
  SurrogateKeyError,
  writeUserConfig,
} from "../src/user-config.js";

// test/setup.ts pins FICTA_CONFIG_FILE=0, so startProxy never reads a real ~/.ficta/config.toml.
const KEY_ENVS = ["FICTA_SURROGATE_KEY", "FICTA_SURROGATE_KEY_FILE", "FICTA_REQUIRE_STABLE_SURROGATE_KEY"] as const;
const FILE_KEY = "a".repeat(32) + "0123456789abcdef".repeat(2);
const OTHER_KEY = "b".repeat(32) + "fedcba9876543210".repeat(2);
const posix = process.platform !== "win32";

let dir: string;
let path: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ficta-key-"));
  path = join(dir, "config.toml");
  saved = {};
  for (const name of KEY_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  resetUserConfigForTests();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of KEY_ENVS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetUserConfigForTests();
});

function writeKeyFile(name: string, contents: string, mode = 0o600): string {
  const file = join(dir, name);
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  return file;
}

describe("ensureSurrogateKey", () => {
  it("generates a 256-bit key when absent, persists it, and activates it", () => {
    const r = ensureSurrogateKey(path);
    expect(r.generated).toBe(true);
    expect(r.status).toEqual({ stable: true, source: "config" });
    expect(process.env.FICTA_SURROGATE_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBe(process.env.FICTA_SURROGATE_KEY);
  });

  it("is idempotent — a fresh process re-reads the same key, never regenerates", () => {
    expect(ensureSurrogateKey(path).generated).toBe(true);
    const key = process.env.FICTA_SURROGATE_KEY;
    delete process.env.FICTA_SURROGATE_KEY; // simulate a new process before loadUserConfig
    resetUserConfigForTests();
    const r = ensureSurrogateKey(path);
    expect(r.generated).toBe(false);
    expect(process.env.FICTA_SURROGATE_KEY).toBe(key);
  });

  it("does nothing when a key is already active in the environment", () => {
    process.env.FICTA_SURROGATE_KEY = "already-set";
    expect(ensureSurrogateKey(path).generated).toBe(false);
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBeUndefined();
  });

  it("does not generate an inline key when config.toml names a key file", () => {
    const file = writeKeyFile("surrogate.key", `${FILE_KEY}\n`);
    writeUserConfig({ FICTA_SURROGATE_KEY_FILE: file }, path);
    const r = ensureSurrogateKey(path);
    expect(r.generated).toBe(false);
    expect(r.status).toEqual({ stable: true, source: "config-key-file", keyFile: file });
    expect(process.env.FICTA_SURROGATE_KEY).toBe(FILE_KEY);
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBeUndefined();
  });

  it("leaves the key ephemeral when generation is disabled", () => {
    const r = ensureSurrogateKey(path, { generate: false });
    expect(r).toMatchObject({ generated: false, status: { stable: false, source: "ephemeral" } });
    expect(process.env.FICTA_SURROGATE_KEY).toBeUndefined();
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBeUndefined();
  });
});

describe("resolveSurrogateKey precedence", () => {
  it("reports an ephemeral key when nothing is configured", () => {
    expect(resolveSurrogateKey(path)).toEqual({ stable: false, source: "ephemeral" });
  });

  it("prefers the FICTA_SURROGATE_KEY env var over a key file", () => {
    process.env.FICTA_SURROGATE_KEY = OTHER_KEY;
    process.env.FICTA_SURROGATE_KEY_FILE = writeKeyFile("surrogate.key", FILE_KEY);
    expect(resolveSurrogateKey(path)).toEqual({ stable: true, source: "env" });
    expect(process.env.FICTA_SURROGATE_KEY).toBe(OTHER_KEY);
  });

  it("prefers a shell key file over an inline key from config.toml", () => {
    writeUserConfig({ FICTA_SURROGATE_KEY: OTHER_KEY }, path);
    ensureSurrogateKey(path); // loads the config key into this process
    const file = writeKeyFile("surrogate.key", FILE_KEY);
    process.env.FICTA_SURROGATE_KEY_FILE = file;
    expect(resolveSurrogateKey(path)).toEqual({ stable: true, source: "env-key-file", keyFile: file });
    expect(process.env.FICTA_SURROGATE_KEY).toBe(FILE_KEY);
    // Re-resolving is idempotent: the activated file key is not mistaken for a shell key.
    expect(resolveSurrogateKey(path).source).toBe("env-key-file");
  });

  it("resolves a relative config key_file against the config directory", () => {
    writeKeyFile("surrogate.key", FILE_KEY);
    writeUserConfig({ FICTA_SURROGATE_KEY_FILE: "surrogate.key" }, path);
    expect(ensureSurrogateKey(path).status).toEqual({
      stable: true,
      source: "config-key-file",
      keyFile: join(dir, "surrogate.key"),
    });
  });

  it("yields the same surrogates as the same key supplied inline", () => {
    process.env.FICTA_SURROGATE_KEY_FILE = writeKeyFile("surrogate.key", FILE_KEY);
    resolveSurrogateKey(path);
    const fromFile = hexSurrogateStrategy(engineConfigFromEnv().surrogate.key).mint("jane.doe@example.com");
    expect(fromFile).toBe(hexSurrogateStrategy(FILE_KEY).mint("jane.doe@example.com"));
  });
});

describe("readSurrogateKeyFile", () => {
  it("accepts 64 hex characters with a trailing newline", () => {
    expect(readSurrogateKeyFile(writeKeyFile("k", `${FILE_KEY}\n`))).toBe(FILE_KEY);
  });

  it.each([
    ["too short", FILE_KEY.slice(0, 63)],
    ["too long", `${FILE_KEY}0`],
    ["not hex", `${FILE_KEY.slice(0, 63)}z`],
    ["empty", ""],
  ])("rejects a key that is %s without echoing it", (_label, contents) => {
    const file = writeKeyFile("k", contents);
    let message = "";
    try {
      readSurrogateKeyFile(file);
    } catch (error) {
      expect(error).toBeInstanceOf(SurrogateKeyError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/64 hex characters/);
    if (contents) expect(message).not.toContain(contents);
  });

  it.runIf(posix)("refuses a key file readable by group or others", () => {
    const file = writeKeyFile("k", FILE_KEY, 0o640);
    expect(() => readSurrogateKeyFile(file)).toThrow(/group\/others .*chmod 600/);
  });

  it("refuses a missing key file", () => {
    expect(() => readSurrogateKeyFile(join(dir, "missing"))).toThrow(/not readable \(ENOENT\)/);
  });
});

describe("surrogate.require_stable_key", () => {
  it("passes when a key is configured", () => {
    process.env.FICTA_REQUIRE_STABLE_SURROGATE_KEY = "1";
    process.env.FICTA_SURROGATE_KEY_FILE = writeKeyFile("surrogate.key", FILE_KEY);
    expect(checkSurrogateKey(path).stable).toBe(true);
  });

  it("refuses an ephemeral key with a clear error", () => {
    process.env.FICTA_REQUIRE_STABLE_SURROGATE_KEY = "1";
    expect(() => checkSurrogateKey(path)).toThrow(/require_stable_key is set but no surrogate key is configured/);
  });

  it("is off by default", () => {
    expect(checkSurrogateKey(path)).toEqual({ stable: false, source: "ephemeral" });
  });

  it("lets the proxy start on an ephemeral key when not required (the CLI keeps the fallback)", async () => {
    // The engine package refuses to construct without a key unless the host opts in; the proxy does.
    const proxy = await startProxy({ port: 0, plugins: [] });
    try {
      expect(proxy.port).toBeGreaterThan(0);
    } finally {
      proxy.close();
    }
  });

  it("makes the proxy fail at startup instead of minting a random key", async () => {
    process.env.FICTA_REQUIRE_STABLE_SURROGATE_KEY = "1";
    await expect(startProxy({ port: 0, plugins: [] })).rejects.toThrow(SurrogateKeyError);
  });

  it("makes the proxy fail at startup on an unusable key file", async () => {
    process.env.FICTA_SURROGATE_KEY_FILE = writeKeyFile("surrogate.key", "not-a-key");
    await expect(startProxy({ port: 0, plugins: [] })).rejects.toThrow(/64 hex characters/);
  });
});

describe("reference deployment config (deploy/ficta-config.toml)", () => {
  const deployConfig = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "ficta-config.toml");

  it("names the installer's key file and requires a stable key", () => {
    const values = readUserConfig(deployConfig);
    expect(values.FICTA_SURROGATE_KEY_FILE).toBe("/var/lib/ficta/.ficta/surrogate.key");
    expect(values.FICTA_REQUIRE_STABLE_SURROGATE_KEY).toBe("1");
    expect(values.FICTA_SURROGATE_KEY).toBeUndefined();
  });

  it("makes the proxy refuse to start when that key file is missing", async () => {
    const values = readUserConfig(deployConfig);
    process.env.FICTA_REQUIRE_STABLE_SURROGATE_KEY = values.FICTA_REQUIRE_STABLE_SURROGATE_KEY;
    process.env.FICTA_SURROGATE_KEY_FILE = join(dir, "surrogate.key"); // same setting, absent file
    await expect(startProxy({ port: 0, plugins: [] })).rejects.toThrow(SurrogateKeyError);
  });

  it("leaves permanent removal off (an opt-in firm policy) while keeping entity priority", () => {
    const values = readUserConfig(deployConfig);
    expect(values.FICTA_DESTROY_CATEGORIES).toBeUndefined();
    expect(values.FICTA_DESTROY_LABELS).toBeUndefined();
    expect(values.FICTA_ENTITY_PRIORITY).toBe("za-id-number,credit-card");
    const engine = engineConfigFromEnv({ ...values, FICTA_SURROGATE_KEY: FILE_KEY });
    expect(engine.dispositions.destroy).toEqual({ all: false, categories: [], labels: {} });
    expect(engine.detection.entityPriority).toEqual(["za-id-number", "credit-card"]);
  });

  it("keeps surrogates stable once the installer's key file exists", () => {
    process.env.FICTA_REQUIRE_STABLE_SURROGATE_KEY = readUserConfig(deployConfig).FICTA_REQUIRE_STABLE_SURROGATE_KEY;
    process.env.FICTA_SURROGATE_KEY_FILE = writeKeyFile("surrogate.key", `${FILE_KEY}\n`);
    expect(checkSurrogateKey(path)).toMatchObject({ stable: true, source: "env-key-file" });
  });
});
