// Shared setup for the live, real-agent e2e tests: which real binaries to drive, how to call each
// one headlessly, and when to skip. See test/e2e/README.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultShimDir, findExecutable } from "../../src/install.js";

export const E2E = process.env.FICTA_E2E === "1";

export const REPO = process.cwd();
export const TSX = join(REPO, "node_modules", ".bin", "tsx");
export const CLI = join(REPO, "src", "cli.ts");

export interface AgentSpec {
  /** ficta agent command. */
  name: string;
  /** Headless single-turn args with the prompt in place. */
  args: () => string[];
  /** True when the agent's own provider auth looks present. */
  authPresent: () => boolean;
  /** Human-readable note about how auth is detected (for skip messages). */
  authHint: string;
}

export function realBinary(name: string): string | undefined {
  const override = process.env[`FICTA_REAL_${name.toUpperCase()}`];
  if (override) return override;
  const excludeDirs = [defaultShimDir(), process.env.FICTA_SHIM_DIR].filter((v): v is string => Boolean(v));
  return findExecutable(name, { excludeDirs });
}

// Use Pi's real default provider (e.g. openai-codex) so the test exercises what the
// user actually runs, not a provider they may not be authed for.
function piDefaultProvider(): string {
  if (process.env.FICTA_E2E_PI_PROVIDER) return process.env.FICTA_E2E_PI_PROVIDER;
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
    if (typeof s.defaultProvider === "string") return s.defaultProvider;
  } catch {
    // No settings; fall through to default.
  }
  return "openai-codex";
}
const PI_PROVIDER = piDefaultProvider();
const PI_MODEL = process.env.FICTA_E2E_PI_MODEL;

// Restrict to named agents for cheaper targeted runs, e.g. FICTA_E2E_ONLY=claude.
export const ONLY = (process.env.FICTA_E2E_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Negative control: point the registry elsewhere (e.g. /dev/null) so the canary
// is NOT protected — the suite must then FAIL, proving the assertions bite.
export const REGISTRY_OVERRIDE = process.env.FICTA_E2E_REGISTRY_OVERRIDE;

/**
 * The supported agents, each told `prompt`. `tools: "read-shell"` also lets claude run shell commands
 * (codex `exec -s read-only` and pi can already run read-only commands).
 */
export function agentSpecs(prompt: string, tools: "read" | "read-shell" = "read"): AgentSpec[] {
  return [
    {
      name: "claude",
      // `--allowedTools <tools...>` is variadic and greedily consumes following
      // positionals, so the prompt must come before it or claude sees no prompt.
      args: () => [
        "-p",
        ...(process.env.FICTA_E2E_CLAUDE_MODEL ? ["--model", process.env.FICTA_E2E_CLAUDE_MODEL] : []),
        prompt,
        "--allowedTools",
        ...(tools === "read-shell" ? ["Read", "Bash"] : ["Read"]),
      ],
      authPresent: () => existsSync(join(homedir(), ".claude")) || Boolean(process.env.ANTHROPIC_API_KEY),
      authHint: "~/.claude or ANTHROPIC_API_KEY",
    },
    {
      name: "codex",
      args: () => [
        "exec",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        ...(process.env.FICTA_E2E_CODEX_MODEL ? ["-m", process.env.FICTA_E2E_CODEX_MODEL] : []),
        prompt,
      ],
      authPresent: () => existsSync(join(homedir(), ".codex", "auth.json")) || Boolean(process.env.OPENAI_API_KEY),
      authHint: "~/.codex/auth.json or OPENAI_API_KEY",
    },
    {
      name: "pi",
      args: () => ["-p", "--provider", PI_PROVIDER, ...(PI_MODEL ? ["--model", PI_MODEL] : []), "--no-session", prompt],
      // Pi stores its own logins in ~/.pi/agent/auth.json (provider-independent), so
      // that is the real auth signal — not shell API-key env vars.
      authPresent: () =>
        existsSync(join(homedir(), ".pi", "agent", "auth.json")) ||
        Boolean(process.env.OPENAI_API_KEY) ||
        Boolean(process.env.ANTHROPIC_API_KEY),
      authHint: `~/.pi/agent/auth.json for provider '${PI_PROVIDER}' (override with FICTA_E2E_PI_PROVIDER)`,
    },
  ];
}

/** Why this agent cannot run here, or "" when it can. */
export function skipReason(agent: AgentSpec, bin: string | undefined): string {
  if (!E2E) return "FICTA_E2E is not set (run via `pnpm test:e2e`)";
  if (ONLY.length && !ONLY.includes(agent.name)) return "excluded by FICTA_E2E_ONLY";
  if (!bin) return `real ${agent.name} binary not found on PATH`;
  if (!agent.authPresent()) return `no auth detected (${agent.authHint})`;
  return "";
}

// Surface the toolchain assumption early with a clear message.
if (E2E && !existsSync(TSX)) {
  throw new Error(`tsx not found at ${TSX}; run \`pnpm install\` before \`pnpm test:e2e\`.`);
}
