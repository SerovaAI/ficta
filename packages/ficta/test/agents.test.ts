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
      "exec",
      "hello",
    ]);
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
    expect(plan.args).toContain(`chatgpt_base_url="${BASE}/backend-api/"`);
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
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual(["exec", "hello"]);
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
