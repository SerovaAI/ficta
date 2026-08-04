// Live, real-agent end-to-end protection check. Opt-in via `pnpm test:e2e`.
//
// For each supported agent this test launches the REAL agent binary through the
// REAL ficta CLI, against the REAL provider (using your own auth), and makes the
// agent read a sample `.env` containing a canary value. It then inspects what
// ficta actually forwarded upstream and asserts the canary was redacted.
//
// This is the only test that proves the end-to-end claim — that a secret pulled
// into the model context never leaves the machine verbatim. It cannot run in the
// default offline suite or CI (needs the binaries, real auth, and spends tokens),
// so it self-skips per agent when the binary or auth is absent.
//
// See test/e2e/README.md for prerequisites, how to run, and the negative control.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectionStatsSnapshot } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { defaultShimDir, findExecutable } from "../../src/install.js";

const E2E = process.env.FICTA_E2E === "1";

// The registered value is a benign, git-SHA-like build ref rather than an obvious
// credential: safety-tuned agents refuse to read a file that is plainly a secret
// tripwire, which prevents the value from ever entering context. ficta's redaction
// is value-exact regardless of how the value "looks", so a mundane config lookup
// proves the same guarantee without provoking a refusal. High-entropy, >=
// FICTA_REGISTRY_MIN_LEN, and non-path-like (no "/").
const SECRET_FILE = "service.env";
const SECRET_VAR = "BUILD_REF";
const CANARY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const PROMPT = `Read ${SECRET_FILE} in the current working directory and tell me the value of ${SECRET_VAR}.`;

const REPO = process.cwd();
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const CLI = join(REPO, "src", "cli.ts");

interface AgentSpec {
  /** ficta agent command. */
  name: string;
  /** Headless single-turn args; the canary PROMPT is appended last. */
  args: () => string[];
  /** True when the agent's own provider auth looks present. */
  authPresent: () => boolean;
  /** Human-readable note about how auth is detected (for skip messages). */
  authHint: string;
}

function realBinary(name: string): string | undefined {
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
const ONLY = (process.env.FICTA_E2E_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Negative control: point the registry elsewhere (e.g. /dev/null) so the canary
// is NOT protected — the suite must then FAIL, proving the assertions bite.
const REGISTRY_OVERRIDE = process.env.FICTA_E2E_REGISTRY_OVERRIDE;

const AGENTS: AgentSpec[] = [
  {
    name: "claude",
    // `--allowedTools <tools...>` is variadic and greedily consumes following
    // positionals, so the PROMPT must come before it or claude sees no prompt.
    args: () => [
      "-p",
      ...(process.env.FICTA_E2E_CLAUDE_MODEL ? ["--model", process.env.FICTA_E2E_CLAUDE_MODEL] : []),
      PROMPT,
      "--allowedTools",
      "Read",
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
      PROMPT,
    ],
    authPresent: () => existsSync(join(homedir(), ".codex", "auth.json")) || Boolean(process.env.OPENAI_API_KEY),
    authHint: "~/.codex/auth.json or OPENAI_API_KEY",
  },
  {
    name: "pi",
    args: () => ["-p", "--provider", PI_PROVIDER, ...(PI_MODEL ? ["--model", PI_MODEL] : []), "--no-session", PROMPT],
    // Pi stores its own logins in ~/.pi/agent/auth.json (provider-independent), so
    // that is the real auth signal — not shell API-key env vars.
    authPresent: () =>
      existsSync(join(homedir(), ".pi", "agent", "auth.json")) ||
      Boolean(process.env.OPENAI_API_KEY) ||
      Boolean(process.env.ANTHROPIC_API_KEY),
    authHint: `~/.pi/agent/auth.json for provider '${PI_PROVIDER}' (override with FICTA_E2E_PI_PROVIDER)`,
  },
];

interface RunArtifacts {
  status: number | null;
  stdout: string;
  stderr: string;
  logDir: string;
  requestMeta: RequestMeta[];
  restoreMeta: RestoreMeta[];
  stats?: ProtectionStatsSnapshot;
}

interface RequestMeta {
  kind: "request";
  n: number;
  method: string;
  path: string;
  wire: string;
  bodyLogged: boolean;
  registeredValues: number;
  inspection: {
    enabled: boolean;
    registeredValues: number;
    hits: Array<{ path: string; names: string[] }>;
    truncated: boolean;
  };
}

interface RestoreMeta {
  kind: "restore";
  n: number;
  restoredValues: number;
  restoredIntoToolsValues: number;
  withheldFromToolsValues: number;
  residualSurrogateValues: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function collectProof(logDir: string): {
  requestMeta: RequestMeta[];
  restoreMeta: RestoreMeta[];
  stats?: ProtectionStatsSnapshot;
} {
  const statsPath = join(logDir, "protection-stats.json");
  const stats = existsSync(statsPath) ? readJson<ProtectionStatsSnapshot>(statsPath) : undefined;
  if (!existsSync(logDir)) return { requestMeta: [], restoreMeta: [], stats };
  const runsDir = join(logDir, "runs");
  if (!existsSync(runsDir)) return { requestMeta: [], restoreMeta: [], stats };
  const requestMeta: RequestMeta[] = [];
  const restoreMeta: RestoreMeta[] = [];
  for (const run of readdirSync(runsDir).filter((n) => n.startsWith("run-"))) {
    const runDir = join(runsDir, run);
    for (const file of readdirSync(runDir)) {
      const path = join(runDir, file);
      if (/^req-\d+\.meta\.json$/.test(file)) requestMeta.push(readJson<RequestMeta>(path));
      else if (/^res-\d+\.restore\.meta\.json$/.test(file)) restoreMeta.push(readJson<RestoreMeta>(path));
    }
  }
  return {
    requestMeta: requestMeta.sort((a, b) => a.n - b.n),
    restoreMeta: restoreMeta.sort((a, b) => a.n - b.n),
    stats,
  };
}

function runAgent(agent: AgentSpec, bin: string): RunArtifacts {
  const projectDir = mkdtempSync(join(tmpdir(), `ficta-e2e-${agent.name}-`));
  const logDir = mkdtempSync(join(tmpdir(), `ficta-e2e-${agent.name}-logs-`));
  writeFileSync(join(projectDir, SECRET_FILE), `${SECRET_VAR}=${CANARY}\n`);

  const res = spawnSync(TSX, [CLI, agent.name, ...agent.args()], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 110_000,
    env: {
      ...process.env,
      // Point ficta's real-agent resolver at the binary we located.
      [`FICTA_REAL_${agent.name.toUpperCase()}`]: bin,
      // Register only the canary; ignore ambient sources and user config.
      FICTA_CONFIG_FILE: "0",
      FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
      FICTA_REGISTRY_ENV_FILE_PATHS: REGISTRY_OVERRIDE ?? join(projectDir, SECRET_FILE),
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: "0",
      FICTA_REGISTRY_DOPPLER_ENABLED: "0",
      FICTA_REGISTRY_MIN_LEN: "8",
      // Refuse to launch if the canary did not load — catches test-setup breakage.
      // Relaxed for the negative control, which deliberately registers nothing.
      FICTA_REQUIRE_REGISTRY: REGISTRY_OVERRIDE ? "0" : "1",
      // Keep detailed diagnostics. Raw bodies intentionally remain disabled: the live proof uses
      // values-free request metadata plus structured redaction/restore statistics.
      FICTA_LOG_LEVEL: "trace",
      FICTA_LOG_DIR: logDir,
    },
  });

  const proof = collectProof(logDir);
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    logDir,
    ...proof,
  };
}

describe("live redaction through real agents", () => {
  for (const agent of AGENTS) {
    const bin = E2E ? realBinary(agent.name) : undefined;
    const skip = !E2E
      ? "FICTA_E2E is not set (run via `pnpm test:e2e`)"
      : ONLY.length && !ONLY.includes(agent.name)
        ? "excluded by FICTA_E2E_ONLY"
        : !bin
          ? `real ${agent.name} binary not found on PATH`
          : !agent.authPresent()
            ? `no auth detected (${agent.authHint})`
            : "";

    if (skip) {
      it.skip(`${agent.name}: SKIPPED — ${skip}`, () => {});
      continue;
    }

    it(`${agent.name}: redacts a canary the agent reads from .env`, () => {
      const run = runAgent(agent, bin as string);
      const diag =
        `\n--- ${agent.name} exit=${run.status} ---\n` +
        `artifacts: ${run.logDir}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

      expect(run.status, `real ${agent.name} process did not exit cleanly.${diag}`).toBe(0);

      // The agent must have pulled the canary into the request, otherwise we
      // cannot verify protection (a silent no-op would be a false pass).
      // The safe request sidecar records registered label hits without persisting the value.
      const modelRequests = run.requestMeta.filter((request) => request.wire !== "unknown");
      const canaryRequests = modelRequests.filter((request) =>
        request.inspection.hits.some((hit) => hit.names.includes(SECRET_VAR)),
      );
      expect(
        modelRequests.length,
        `ficta recorded no model requests — the agent bypassed the proxy or never contacted its provider.${diag}`,
      ).toBeGreaterThan(0);
      expect(
        canaryRequests.length,
        `no proxied request contained the registered ${SECRET_VAR} value — cannot verify redaction.${diag}`,
      ).toBeGreaterThan(0);
      expect(canaryRequests.every((request) => request.bodyLogged === false)).toBe(true);

      // Core guarantee: every request that contained the canary has a linked structured event saying
      // the value was redacted, no registered value survived screening, and the request was forwarded.
      expect(run.stats, `ficta did not write protection-stats.json.${diag}`).toBeDefined();
      const stats = run.stats as ProtectionStatsSnapshot;
      const canaryRequestIds = new Set(canaryRequests.map((request) => request.n));
      const canaryEvents = stats.events.filter(
        (event) =>
          event.requestId !== undefined &&
          canaryRequestIds.has(event.requestId) &&
          event.redactedHits.some((hit) => hit.name === SECRET_VAR),
      );
      expect(
        canaryEvents.length,
        `no redaction event was linked to the canary-bearing request.${diag}`,
      ).toBeGreaterThan(0);
      for (const event of canaryEvents) {
        expect(event).toMatchObject({
          method: "POST",
          surface: "body",
          redactedValues: 1,
          survivingValues: 0,
          blocked: false,
        });
        expect(event.survivingHits).toEqual([]);
      }
      expect(stats.totals).toMatchObject({
        survivingValues: 0,
        blockedRequests: 0,
      });
      expect(stats.totals.redactedValues).toBeGreaterThanOrEqual(canaryEvents.length);
      expect(stats.totals.keptOutOfModelValues).toBeGreaterThanOrEqual(canaryEvents.length);
      expect(stats.byLabel).toContainEqual(
        expect.objectContaining({
          name: SECRET_VAR,
          source: "env-file",
          plugin: "known-env-values",
          kind: "secret",
          confidence: "exact",
          survivingValues: 0,
        }),
      );

      // Secondary (soft): local restore should hand the agent the real value back. Some clients stop
      // consuming after their protocol-level completion event, so the stream flush that records restore
      // telemetry is not guaranteed to run. Cross-check it when present; keep stdout soft because model
      // phrasing varies too.
      const restoredValues = run.restoreMeta.reduce((total, meta) => total + meta.restoredValues, 0);
      expect(stats.totals.restoredValues).toBe(restoredValues);
      if (restoredValues === 0 && !run.stdout.includes(CANARY)) {
        console.warn(
          `[e2e] ${agent.name}: no restore telemetry and restored canary not found verbatim in stdout ` +
            `(redaction passed; restore/round-trip unconfirmed).`,
        );
      }
    });
  }
});

// Surface the toolchain assumption early with a clear message.
if (E2E && !existsSync(TSX)) {
  throw new Error(`tsx not found at ${TSX}; run \`pnpm install\` before \`pnpm test:e2e\`.`);
}
