import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCommands,
  claudeAgent,
  codexAgent,
  codexPersistedFictaCleanupOverrides,
  findAgentIntegration,
  piAgent,
  piModelsConfig,
} from "../src/plugins/index.js";

const BASE = "http://127.0.0.1:8787";

function codexExecutable(home: string, supportsNoDaemon: boolean, helpExitCode = 0): string {
  const executable = join(home, "codex");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      `  printf '%s\\n' 'Usage: codex [OPTIONS]' '${supportsNoDaemon ? "  --no-daemon  Run without the shared background server" : "  --no-alt-screen  Disable alternate screen mode"}'`,
      `  exit ${helpExitCode}`,
      "fi",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

describe("agent integration plugins", () => {
  it("exposes built-in agent commands through the plugin registry", () => {
    expect(agentCommands()).toEqual(expect.arrayContaining(["claude", "codex", "pi"]));
    expect(findAgentIntegration("pi")?.label).toContain("Pi");
  });

  it("marks non-model agent commands for passthrough", () => {
    expect(claudeAgent.shouldBypass?.(["--version"])).toBe(true);
    expect(codexAgent.shouldBypass?.(["--help"])).toBe(true);
    expect(piAgent.shouldBypass?.(["install", "npm:@pkg/example"])).toBe(true);
    expect(piAgent.shouldBypass?.(["-p", "hello"])).toBe(false);
  });

  it("marks machine-readable agent commands for quiet startup diagnostics", () => {
    expect(claudeAgent.isMachineReadable?.(["-p", "--output-format", "json"])).toBe(true);
    expect(claudeAgent.isMachineReadable?.(["-p", "--output-format=json"])).toBe(true);
    expect(claudeAgent.isMachineReadable?.(["-p", "--output-format", "stream-json"])).toBe(true);
    expect(claudeAgent.isMachineReadable?.(["-p", "--output-format", "text"])).toBe(false);
    expect(codexAgent.isMachineReadable?.(["exec", "--json", "hello"])).toBe(true);
    expect(codexAgent.isMachineReadable?.(["exec", "hello"])).toBe(false);
  });

  it("blocks `claude remote-control`, which ficta routing cannot serve", () => {
    const notice = claudeAgent.preflight?.(["remote-control"], {});
    expect(notice?.level).toBe("block");
    expect(notice?.lines.join("\n")).toContain("FICTA_DISABLE=1 claude remote-control");
  });

  it("warns but allows a remote-control flag on an otherwise normal session", () => {
    for (const flag of ["--remote-control", "--rc"]) {
      const notice = claudeAgent.preflight?.(["--dangerously-skip-permissions", flag], {});
      expect(notice?.level).toBe("warn");
      expect(notice?.lines[0]).toContain(flag);
    }
  });

  it("leaves ordinary Claude Code invocations unflagged", () => {
    expect(claudeAgent.preflight?.([], {})).toBeUndefined();
    expect(claudeAgent.preflight?.(["-p", "summarize the diff"], {})).toBeUndefined();
    // A session-name prefix only ever accompanies the subcommand, which is already blocked above.
    expect(claudeAgent.preflight?.(["--model", "opus"], {})).toBeUndefined();
  });

  it("configures Claude Code via ANTHROPIC_BASE_URL", () => {
    const plan = claudeAgent.configureLaunch({
      baseUrl: BASE,
      args: ["--version"],
      realExecutable: "/bin/claude",
      env: {},
      cwd: process.cwd(),
    });

    expect(plan.executable).toBe("/bin/claude");
    expect(plan.args).toEqual(["--version"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe(BASE);
  });

  it("configures Codex API-key mode through a temporary provider override", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-api-home-"));
    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.executable).toBe("/bin/codex");
    expect(plan.args).toEqual([
      "-c",
      'model_provider="ficta"',
      "-c",
      'model_providers.ficta.name="ficta"',
      "-c",
      `model_providers.ficta.base_url="${BASE}/v1"`,
      "-c",
      "analytics.enabled=false",
      "exec",
      "hello",
    ]);
  });

  it("keeps the launch token out of Codex argv, delivering it via an env-mapped header", () => {
    const token = "tok-secret-abc123";
    const plan = codexAgent.configureLaunch({
      baseUrl: `${BASE}/__ficta_l/${token}`,
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: {},
      cwd: process.cwd(),
    });

    // The token must never appear on the command line (ps-visible); base_url uses the bare origin.
    expect(plan.args.some((a) => a.includes(token))).toBe(false);
    expect(plan.args.some((a) => a.includes("__ficta_l"))).toBe(false);
    expect(plan.args).toContain(`model_providers.ficta.base_url="${BASE}/v1"`);
    // The header override references the env var *name*, and the token value rides in the child env.
    expect(plan.args.some((a) => a.includes("env_http_headers") && a.includes("x-ficta-launch"))).toBe(true);
    expect(plan.env.FICTA_CODEX_LAUNCH_TOKEN).toBe(token);
  });

  it("configures Codex ChatGPT/OAuth mode when auth.json says chatgpt", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-home-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));

    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: [],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.args).toContain("model_providers.ficta.requires_openai_auth=true");
    expect(plan.args.some((a) => a.startsWith("chatgpt_base_url="))).toBe(false);
    expect(plan.args).toContain("analytics.enabled=false");
  });

  it.each([{ args: [] }, { args: ["resume", "--last"] }, { args: ["exec", "--json", "hello"] }])(
    "explicitly selects embedded Codex mode when supported for args %j",
    ({ args }) => {
      const home = mkdtempSync(join(tmpdir(), "ficta-codex-daemon-home-"));
      const env = { CODEX_HOME: home };
      const plan = codexAgent.configureLaunch({
        baseUrl: BASE,
        args,
        realExecutable: codexExecutable(home, true),
        env,
        cwd: process.cwd(),
      });

      expect(plan.args[0]).toBe("--no-daemon");
      expect(plan.args).toContain('model_provider="ficta"');
      expect(plan.args).toContain(`model_providers.ficta.base_url="${BASE}/v1"`);
      expect(plan.args).toContain("analytics.enabled=false");
      expect(plan.args.slice(plan.args.length - args.length)).toEqual(args);
      expect(plan.env).toBe(env);
    },
  );

  it.each([
    { supported: false, exitCode: 0 },
    { supported: true, exitCode: 1 },
  ])("keeps Codex compatible when help reports %j", ({ supported, exitCode }) => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-legacy-home-"));
    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: [],
      realExecutable: codexExecutable(home, supported, exitCode),
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.args).not.toContain("--no-daemon");
    expect(plan.args).toContain('model_provider="ficta"');
  });

  it("preserves an explicit Codex --no-daemon without duplicating it", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-explicit-home-"));
    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: ["--no-daemon", "resume", "--last"],
      realExecutable: codexExecutable(home, true),
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.args.filter((arg) => arg === "--no-daemon")).toHaveLength(1);
    expect(plan.args.slice(-3)).toEqual(["--no-daemon", "resume", "--last"]);
  });

  it("neutralizes stale persisted Codex ficta routing on FICTA_DISABLE bypass", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-stale-home-"));
    writeFileSync(
      join(home, "config.toml"),
      [
        'model_provider = "ficta"',
        'openai_base_url = "http://localhost:8787/v1"',
        'chatgpt_base_url = "http://localhost:8787/backend-api/"',
        "",
        "[model_providers.ficta]",
        'base_url = "http://localhost:8787/v1"',
      ].join("\n"),
    );

    expect(codexPersistedFictaCleanupOverrides({ CODEX_HOME: home })).toEqual([
      'model_provider="openai"',
      'openai_base_url="https://api.openai.com/v1"',
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ]);

    const plan = codexAgent.configureBypass?.({
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual([
      "-c",
      'model_provider="openai"',
      "-c",
      'openai_base_url="https://api.openai.com/v1"',
      "-c",
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      "exec",
      "hello",
    ]);
  });

  it("bypasses stale Codex ficta routing to ChatGPT backend for OAuth auth", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-stale-oauth-home-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    writeFileSync(
      join(home, "config.toml"),
      [
        'model_provider = "ficta"',
        'chatgpt_base_url = "http://localhost:8787/backend-api/"',
        "",
        "[model_providers.ficta]",
        'base_url = "http://localhost:8787/v1"',
        "requires_openai_auth = true",
      ].join("\n"),
    );

    expect(codexPersistedFictaCleanupOverrides({ CODEX_HOME: home })).toEqual([
      'model_provider="ficta_direct_chatgpt"',
      'model_providers.ficta_direct_chatgpt.name="ChatGPT direct (ficta bypass)"',
      'model_providers.ficta_direct_chatgpt.base_url="https://chatgpt.com/backend-api/codex"',
      "model_providers.ficta_direct_chatgpt.requires_openai_auth=true",
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ]);
  });

  it("leaves Codex bypass args alone when no stale persisted ficta routing is present", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-clean-home-"));
    writeFileSync(join(home, "config.toml"), 'model_provider = "openrouter"\n');

    const plan = codexAgent.configureBypass?.({
      args: ["exec", "hello"],
      realExecutable: codexExecutable(home, true),
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual(["exec", "hello"]);
  });

  it("selects embedded Codex mode for stale-routing cleanup overrides on bypass", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-bypass-daemon-home-"));
    writeFileSync(join(home, "config.toml"), 'model_provider = "ficta"\n');
    const plan = codexAgent.configureBypass?.({
      args: ["resume", "--last"],
      realExecutable: codexExecutable(home, true),
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual(["--no-daemon", "-c", 'model_provider="openai"', "resume", "--last"]);
  });

  it("routes Pi through an ephemeral PI_CODING_AGENT_DIR with a ficta models.json", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "ficta-pi-src-"));
    writeFileSync(join(sourceDir, "auth.json"), '{"anthropic":{}}');
    writeFileSync(join(sourceDir, "settings.json"), '{"defaultProvider":"openai-codex"}');
    writeFileSync(
      join(sourceDir, "models.json"),
      '{"providers":{"minimax":{"baseUrl":"https://api.minimax.io/anthropic"}}}',
    );

    const plan = piAgent.configureLaunch({
      baseUrl: BASE,
      args: ["-p", "hello"],
      realExecutable: "/bin/pi",
      env: { PI_CODING_AGENT_DIR: sourceDir },
      cwd: process.cwd(),
    });
    const agentDir = plan.env.PI_CODING_AGENT_DIR as string;

    expect(plan.executable).toBe("/bin/pi");
    expect(plan.args).toEqual(["-p", "hello"]); // no extension injection
    expect(agentDir).toBeTruthy();
    expect(agentDir).not.toBe(sourceDir);

    // Real auth/settings are mirrored so Pi keeps its credentials.
    expect(existsSync(join(agentDir, "auth.json"))).toBe(true);
    expect(existsSync(join(agentDir, "settings.json"))).toBe(true);

    // models.json routes built-ins through ficta and preserves the custom provider.
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(models.providers.anthropic.baseUrl).toBe(BASE);
    expect(models.providers.openai.baseUrl).toBe(`${BASE}/v1`);
    expect(models.providers["openai-codex"].baseUrl).toBe(`${BASE}/backend-api`);
    expect(models.providers.minimax.baseUrl).toBe("https://api.minimax.io/anthropic"); // untouched

    await plan.cleanup?.();
    expect(existsSync(agentDir)).toBe(false);
  });

  it("places the Pi mirror beside the real agent dir so relative package sources keep resolving", async () => {
    // Layout: parent/agent (real dir), parent/tools/ext (a local extension referenced as ../tools/ext).
    const parent = mkdtempSync(join(tmpdir(), "ficta-pi-parent-"));
    const sourceDir = join(parent, "agent");
    mkdirSync(sourceDir);
    mkdirSync(join(parent, "tools", "ext"), { recursive: true });
    writeFileSync(join(sourceDir, "settings.json"), '{"packages":["../tools/ext"]}');

    const plan = piAgent.configureLaunch({
      baseUrl: BASE,
      args: ["-p", "hello"],
      realExecutable: "/bin/pi",
      env: { PI_CODING_AGENT_DIR: sourceDir },
      cwd: process.cwd(),
    });
    const agentDir = plan.env.PI_CODING_AGENT_DIR as string;

    // Sibling of the real dir — Pi resolves "../tools/ext" against the agent dir with plain path
    // math, so only a same-parent mirror keeps it pointing at the real extension.
    expect(dirname(agentDir)).toBe(parent);
    expect(resolve(agentDir, "../tools/ext")).toBe(join(parent, "tools", "ext"));
    expect(existsSync(resolve(agentDir, "../tools/ext"))).toBe(true);

    await plan.cleanup?.();
    expect(existsSync(agentDir)).toBe(false);
  });

  it("sweeps orphaned Pi mirrors older than a day but leaves fresh ones", () => {
    const parent = mkdtempSync(join(tmpdir(), "ficta-pi-parent-"));
    const sourceDir = join(parent, "agent");
    mkdirSync(sourceDir);
    const stale = join(parent, ".ficta-pi-stale");
    const fresh = join(parent, ".ficta-pi-fresh");
    mkdirSync(stale);
    mkdirSync(fresh);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    const plan = piAgent.configureLaunch({
      baseUrl: BASE,
      args: ["-p", "hello"],
      realExecutable: "/bin/pi",
      env: { PI_CODING_AGENT_DIR: sourceDir },
      cwd: process.cwd(),
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    return plan.cleanup?.();
  });

  it("piModelsConfig overrides built-in providers and preserves custom ones", () => {
    const out = JSON.parse(
      piModelsConfig(BASE, '{"providers":{"minimax":{"baseUrl":"https://api.minimax.io/anthropic"}}}'),
    );
    expect(out.providers.anthropic.baseUrl).toBe(BASE);
    expect(out.providers.openai.baseUrl).toBe(`${BASE}/v1`);
    expect(out.providers["openai-codex"].baseUrl).toBe(`${BASE}/backend-api`);
    expect(out.providers.minimax.baseUrl).toBe("https://api.minimax.io/anthropic");
  });
});
