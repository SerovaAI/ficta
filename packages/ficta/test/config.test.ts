import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeLogDir, loadConfig, upstreamPolicyIssue } from "../src/config.js";
import { defaultLogDir } from "../src/defaults.js";
import { configPath, readUserConfig, writeUserConfig } from "../src/user-config.js";

const originalLogLevel = process.env.FICTA_LOG_LEVEL;
const originalTraceAudit = process.env.FICTA_TRACE_AUDIT;
const originalConfigFile = process.env.FICTA_CONFIG_FILE;
const originalHost = process.env.FICTA_HOST;
const originalLogDir = process.env.FICTA_LOG_DIR;
const originalLogRoot = process.env.FICTA_LOG_ROOT;
const originalLogRole = process.env.FICTA_LOG_ROLE;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.FICTA_LOG_LEVEL;
  else process.env.FICTA_LOG_LEVEL = originalLogLevel;

  if (originalTraceAudit === undefined) delete process.env.FICTA_TRACE_AUDIT;
  else process.env.FICTA_TRACE_AUDIT = originalTraceAudit;

  if (originalConfigFile === undefined) delete process.env.FICTA_CONFIG_FILE;
  else process.env.FICTA_CONFIG_FILE = originalConfigFile;

  if (originalHost === undefined) delete process.env.FICTA_HOST;
  else process.env.FICTA_HOST = originalHost;

  restore("FICTA_LOG_DIR", originalLogDir);
  restore("FICTA_LOG_ROOT", originalLogRoot);
  restore("FICTA_LOG_ROLE", originalLogRole);
});

describe("config hardening", () => {
  it("defaults to the info log level with raw body logging off", () => {
    delete process.env.FICTA_LOG_LEVEL;
    expect(loadConfig().logLevel).toBe("info");
    expect(loadConfig().logBodies).toBe(false);
  });

  it("binds loopback by default and honours FICTA_HOST for an explicit override", () => {
    delete process.env.FICTA_HOST;
    expect(loadConfig().host).toBe("127.0.0.1");

    // Exposing the proxy on the network is opt-in via FICTA_HOST (it forwards provider auth headers).
    process.env.FICTA_HOST = "0.0.0.0";
    expect(loadConfig().host).toBe("0.0.0.0");
  });

  it("only writes raw bodies at the trace level", () => {
    process.env.FICTA_LOG_LEVEL = "trace";
    expect(loadConfig().logBodies).toBe(true);

    for (const level of ["debug", "info", "warn", "error", "silent"]) {
      process.env.FICTA_LOG_LEVEL = level;
      expect(loadConfig().logBodies).toBe(false);
    }
  });

  it("requires trace level and FICTA_TRACE_AUDIT=1 for raw value audit sidecars", () => {
    process.env.FICTA_TRACE_AUDIT = "1";

    process.env.FICTA_LOG_LEVEL = "trace";
    expect(loadConfig().traceAudit).toBe(true);

    process.env.FICTA_LOG_LEVEL = "debug";
    expect(loadConfig().traceAudit).toBe(false);

    delete process.env.FICTA_TRACE_AUDIT;
    process.env.FICTA_LOG_LEVEL = "trace";
    expect(loadConfig().traceAudit).toBe(false);
  });

  it("falls back to info for an unrecognized log level", () => {
    process.env.FICTA_LOG_LEVEL = "verbose";
    expect(loadConfig().logLevel).toBe("info");
  });

  it("expands ~ in FICTA_CONFIG_FILE", () => {
    process.env.FICTA_CONFIG_FILE = "~/custom-ficta/config.toml";
    expect(configPath()).toBe(join(homedir(), "custom-ficta", "config.toml"));
  });

  it("blocks non-default upstreams unless explicitly allowed", () => {
    const cfg = { ...loadConfig(), allowCustomUpstream: false };

    expect(upstreamPolicyIssue(cfg, "https://attacker.example/v1/messages")).toContain("FICTA_ALLOW_CUSTOM_UPSTREAM=1");
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "http://attacker.example/v1/messages")).toContain(
      "must use https",
    );
    expect(
      upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "https://trusted.example/v1/messages"),
    ).toBeUndefined();
  });

  it("treats only real 127.0.0.0/8 literals as loopback, not lookalike DNS names", () => {
    const cfg = { ...loadConfig(), allowCustomUpstream: false };

    // Genuine loopback literals bypass the custom-upstream gate.
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue(cfg, "http://127.1.2.3:9000/v1/messages")).toBeUndefined();
    // Shorthand IPv4 loopback forms are normalized to dotted-quad by URL parsing, so they too pass.
    expect(upstreamPolicyIssue(cfg, "http://127.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue(cfg, "http://2130706433:9000/v1/messages")).toBeUndefined();

    // Registrable names that merely start with "127." resolve to public IPs and must be gated.
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1.attacker.example/v1/messages")).toContain(
      "FICTA_ALLOW_CUSTOM_UPSTREAM=1",
    );
    expect(upstreamPolicyIssue(cfg, "http://127.foo.com/v1/messages")).toContain("FICTA_ALLOW_CUSTOM_UPSTREAM=1");
    // …and even when custom upstreams are allowed, they still must use https.
    expect(
      upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "http://127.0.0.1.attacker.example/v1/messages"),
    ).toContain("must use https");
  });

  it("persists user config as TOML and reads it as effective settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig(
        {
          FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
          FICTA_REGISTRY_ENV_FILE_PATHS: ".env:.env.local:.env.production",
          FICTA_REGISTRY_MANAGED_FILE_ENABLED: "1",
          FICTA_REGISTRY_MANAGED_FILE_PATHS: "/tmp/protected-registry.json",
          FICTA_REGISTRY_DOPPLER_ENABLED: "1",
          FICTA_REGISTRY_DOPPLER_CONFIGS: "dev,prod",
          FICTA_REGISTRY_MIN_LEN: "12",
          FICTA_REQUIRE_REGISTRY: "1",
          FICTA_LOG_MAX_BYTES: "12345",
          FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
        },
        path,
      );

      expect(readFileSync(path, "utf8")).toContain("[registry.env_file]");
      expect(readFileSync(path, "utf8")).toContain('paths = [".env", ".env.local", ".env.production"]');
      expect(readFileSync(path, "utf8")).toContain("[registry.managed_file]");
      expect(readFileSync(path, "utf8")).toContain('paths = ["/tmp/protected-registry.json"]');
      expect(readUserConfig(path)).toMatchObject({
        FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
        FICTA_REGISTRY_ENV_FILE_PATHS: ".env:.env.local:.env.production",
        FICTA_REGISTRY_MANAGED_FILE_ENABLED: "1",
        FICTA_REGISTRY_MANAGED_FILE_PATHS: "/tmp/protected-registry.json",
        FICTA_REGISTRY_DOPPLER_ENABLED: "1",
        FICTA_REGISTRY_DOPPLER_CONFIGS: "dev,prod",
        FICTA_REGISTRY_MIN_LEN: "12",
        FICTA_REQUIRE_REGISTRY: "1",
        FICTA_LOG_MAX_BYTES: "12345",
        FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the per-surface PII toggles as [pii] booleans", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig({ FICTA_PII_ENABLED: "1", FICTA_PII_AGENTS: "1" }, path);

      const toml = readFileSync(path, "utf8");
      expect(toml).toContain("[pii]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("agents = true");
      expect(readUserConfig(path)).toMatchObject({ FICTA_PII_ENABLED: "1", FICTA_PII_AGENTS: "1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the surrogate style as [surrogate] style", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig({ FICTA_SURROGATE_STYLE: "typed" }, path);
      expect(readFileSync(path, "utf8")).toContain("[surrogate]");
      expect(readFileSync(path, "utf8")).toContain('style = "typed"');
      expect(readUserConfig(path)).toMatchObject({ FICTA_SURROGATE_STYLE: "typed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips registry.exclude_names as a comma list, and a single name as a string", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig({ FICTA_REGISTRY_EXCLUDE_NAMES: "FOO,BAR_1" }, path);
      expect(readFileSync(path, "utf8")).toContain('exclude_names = ["FOO", "BAR_1"]');
      expect(readUserConfig(path)).toMatchObject({ FICTA_REGISTRY_EXCLUDE_NAMES: "FOO,BAR_1" });

      // A single name serializes as a TOML string but parses back to the same env value.
      writeUserConfig({ FICTA_REGISTRY_EXCLUDE_NAMES: "SOLO" }, path);
      expect(readUserConfig(path)).toMatchObject({ FICTA_REGISTRY_EXCLUDE_NAMES: "SOLO" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("log dir: root + role split", () => {
  const root = defaultLogDir();

  it("defaults the server/standalone proxy to the gateway subtree", () => {
    expect(composeLogDir({ explicitFromConfig: false })).toBe(join(root, "gateway"));
  });

  it("routes an agent shim to its per-instance subtree via FICTA_LOG_ROLE", () => {
    expect(composeLogDir({ explicitFromConfig: false, role: "agents/claude/2026-07-09T14-46-49-847Z-63580" })).toBe(
      join(root, "agents/claude/2026-07-09T14-46-49-847Z-63580"),
    );
  });

  it("composes a custom FICTA_LOG_ROOT with the role", () => {
    expect(composeLogDir({ explicitFromConfig: false, root: "/var/log/ficta", role: "gateway" })).toBe(
      "/var/log/ficta/gateway",
    );
  });

  it("lets an explicit (shell-set) FICTA_LOG_DIR override the whole path", () => {
    expect(composeLogDir({ explicit: "/tmp/ficta-x", explicitFromConfig: false, role: "agents/claude/inst" })).toBe(
      "/tmp/ficta-x",
    );
    // ~ expansion still applies to the override.
    expect(composeLogDir({ explicit: "~/logs-here", explicitFromConfig: false })).toBe(join(homedir(), "logs-here"));
  });

  it("ignores a neutral legacy config log_dir (== root) so the split still applies", () => {
    // Older `ficta setup` persisted log_dir = <root> into config.toml; treat as neutral.
    expect(composeLogDir({ explicit: root, explicitFromConfig: true, role: "agents/claude/inst" })).toBe(
      join(root, "agents/claude/inst"),
    );
    // But a config-sourced *custom* path is still honored as a full override.
    expect(composeLogDir({ explicit: "/data/ficta", explicitFromConfig: true, role: "agents/claude/inst" })).toBe(
      "/data/ficta",
    );
  });

  it("treats empty-string root/role/explicit as unset (never a relative path)", () => {
    expect(composeLogDir({ explicit: "", explicitFromConfig: false, root: "", role: "" })).toBe(join(root, "gateway"));
    expect(composeLogDir({ explicitFromConfig: false, root: "  ", role: "agents/claude/inst" })).toBe(
      join(root, "agents/claude/inst"),
    );
  });

  it("resolves loadConfig().logDir from FICTA_LOG_ROLE end to end", () => {
    delete process.env.FICTA_LOG_DIR;
    delete process.env.FICTA_LOG_ROOT;
    process.env.FICTA_LOG_ROLE = "agents/codex/inst-1";
    expect(loadConfig().logDir).toBe(join(root, "agents/codex/inst-1"));

    delete process.env.FICTA_LOG_ROLE;
    expect(loadConfig().logDir).toBe(join(root, "gateway"));
  });

  it("keeps concurrent same-agent shims on distinct subtrees", () => {
    const a = composeLogDir({ explicitFromConfig: false, role: "agents/claude/2026-07-09T14-46-39-213Z-63290" });
    const b = composeLogDir({ explicitFromConfig: false, role: "agents/claude/2026-07-09T14-46-49-847Z-63580" });
    expect(a).not.toBe(b);
    expect(a.startsWith(join(root, "agents/claude/"))).toBe(true);
    expect(b.startsWith(join(root, "agents/claude/"))).toBe(true);
  });
});
