// Live leak canary: proves, from what was actually sent upstream, that no planted secret left the
// machine. Opt-in via `pnpm test:e2e` (see test/e2e/README.md).
//
// Each real agent runs through ficta with dev trace on, so every request is captured twice: the
// original (`req-N.json`) and what ficta forwarded (`req-N.sent.json`). The agent reads a notes file
// and runs a shell command over it. The file holds two kinds of canary, each in the shapes that have
// leaked before (git ranges, git errors, URL and file paths, JSON, env assignments):
//   - registered canaries, loaded from a `.env` the way a project's secrets are, including one that
//     looks ordinary, so only the registry protects it;
//   - detector-only canaries (token prefixes, an access key id, a credential URL) that nothing
//     registers, so only ficta's detectors stand between them and the provider.
// The test then requires that every canary reached the agent's requests (otherwise the run proves
// nothing), that no canary appears in any forwarded body, and that `ficta logs audit` agrees.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditLeakCount, auditLogs, formatAuditReport } from "../../src/log-audit.js";
import { type AgentSpec, agentSpecs, CLI, E2E, REGISTRY_OVERRIDE, realBinary, skipReason, TSX } from "./agents.js";

// Synthetic values assembled from parts so no complete credential-shaped literal sits in the source.
const REGISTERED = {
  BUILD_REF: ["5f3c9a1e", "7b2d4f60", "8e1a3c5b", "9d7f2e4a", "6c0b8d1f"].join(""),
  ASSET_KEY: ["Zx9Qw8Vt", "7Lm6Pk3J", "Hj4Np2Rd", "5Wb0Ty1F"].join(""),
  // Plain-looking, so no detector catches it: only the registry protects it. This is what makes the
  // negative control (FICTA_E2E_REGISTRY_OVERRIDE=/dev/null) fail; the random-looking registered
  // values above are also caught by the detectors, which backs the registry up.
  MATTER_CODE: ["MTR", "4417", "QUILL"].join("-"),
};
const DETECTOR_ONLY = {
  githubToken: ["ghp", "_", "R4nd0mT0k3nV4lu3F0rF1ct4C4n4ry", "0000x9"].join(""),
  awsKeyId: ["AK", "IA", "Q7XW4ZP2", "M9LK3RTN"].join(""),
  credentialUrl: ["postgres://svc:", "Pq8", "Zm2Lw9", "Xv4@db.internal.example:5432/app"].join(""),
};
const CANARIES: Record<string, string> = {
  ...REGISTERED,
  ...DETECTOR_ONLY,
  // The password inside the credential URL must not survive on its own either.
  credentialUrlPassword: ["Pq8", "Zm2Lw9", "Xv4"].join(""),
};

const NOTES_FILE = "deploy-notes.md";
const NOTES = `# Deploy notes

Current build ref: ${REGISTERED.BUILD_REF}
Compare with: git log --oneline ${REGISTERED.BUILD_REF}..origin/main -- src/app.ts
Last failure: fatal: bad revision '${REGISTERED.BUILD_REF}..origin/main'
Asset cache file: cache/${REGISTERED.ASSET_KEY}.json
Preview API: https://api.example.test/v1/${REGISTERED.ASSET_KEY}/items
Config JSON: {"build_ref":"${REGISTERED.BUILD_REF}","asset_key":"${REGISTERED.ASSET_KEY}"}
Env: ASSET_KEY=${REGISTERED.ASSET_KEY}
Client matter: ${REGISTERED.MATTER_CODE} (ref kept in the matter tracker)

Legacy CI token (rotated, kept for the audit trail): ${DETECTOR_ONLY.githubToken}
Old access key id: ${DETECTOR_ONLY.awsKeyId}
Staging database: ${DETECTOR_ONLY.credentialUrl}
`;
const PROMPT =
  `Read ${NOTES_FILE} in the current working directory. Then run a shell command that prints the lines ` +
  `of ${NOTES_FILE} containing "ref". Finally summarize the notes in two sentences.`;
const AGENTS = agentSpecs(PROMPT, "read-shell");

interface CanaryRun {
  status: number | null;
  stdout: string;
  stderr: string;
  logDir: string;
  /** Captured bodies by file name: the originals and what ficta forwarded. */
  originals: Map<string, string>;
  sent: Map<string, string>;
}

function capturedBodies(logDir: string): { originals: Map<string, string>; sent: Map<string, string> } {
  const originals = new Map<string, string>();
  const sent = new Map<string, string>();
  const runsDir = join(logDir, "runs");
  for (const run of readdirSync(runsDir).filter((n) => n.startsWith("run-"))) {
    for (const file of readdirSync(join(runsDir, run))) {
      const body = () => readFileSync(join(runsDir, run, file), "utf8");
      if (/^req-\d+\.json$/.test(file)) originals.set(`${run}/${file}`, body());
      else if (/^req-\d+\.sent\.json$/.test(file)) sent.set(`${run}/${file}`, body());
    }
  }
  return { originals, sent };
}

function runAgent(agent: AgentSpec, bin: string): CanaryRun {
  const projectDir = mkdtempSync(join(tmpdir(), `ficta-canary-${agent.name}-`));
  const logDir = mkdtempSync(join(tmpdir(), `ficta-canary-${agent.name}-logs-`));
  const envFile = join(projectDir, "service.env");
  writeFileSync(
    envFile,
    Object.entries(REGISTERED)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  writeFileSync(join(projectDir, NOTES_FILE), NOTES);

  const res = spawnSync(TSX, [CLI, agent.name, ...agent.args()], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 170_000,
    env: {
      ...process.env,
      [`FICTA_REAL_${agent.name.toUpperCase()}`]: bin,
      // Register only the canaries; ignore ambient sources and user config.
      FICTA_CONFIG_FILE: "0",
      FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
      FICTA_REGISTRY_ENV_FILE_PATHS: REGISTRY_OVERRIDE ?? envFile,
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: "0",
      FICTA_REGISTRY_DOPPLER_ENABLED: "0",
      FICTA_REGISTRY_MIN_LEN: "8",
      FICTA_REQUIRE_REGISTRY: REGISTRY_OVERRIDE ? "0" : "1",
      // Capture every request: the original body, the forwarded body, and the audit sidecars.
      FICTA_DEV_TRACE: "1",
      FICTA_LOG_DIR: logDir,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", logDir, ...capturedBodies(logDir) };
}

/** Files whose text holds `value`, raw or JSON-escaped. */
function filesContaining(bodies: Map<string, string>, value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  return [...bodies].filter(([, body]) => body.includes(value) || body.includes(escaped)).map(([file]) => file);
}

describe("live leak canary through real agents (dev trace)", () => {
  for (const agent of AGENTS) {
    const bin = E2E ? realBinary(agent.name) : undefined;
    const skip = skipReason(agent, bin);
    if (skip) {
      it.skip(`${agent.name}: SKIPPED — ${skip}`, () => {});
      continue;
    }

    it(`${agent.name}: no planted secret appears in any forwarded request`, { timeout: 180_000 }, async () => {
      const run = runAgent(agent, bin as string);
      const diag = `\n--- ${agent.name} exit=${run.status} ---\nartifacts: ${run.logDir}\nstderr:\n${run.stderr.slice(-2000)}`;
      expect(run.status, `real ${agent.name} process did not exit cleanly.${diag}`).toBe(0);
      expect(run.sent.size, `no forwarded bodies were captured.${diag}`).toBeGreaterThan(0);

      // Non-vacuous: every canary must have entered the agent's requests, or the run proves nothing.
      const missing = Object.entries(CANARIES)
        .filter(([, value]) => filesContaining(run.originals, value).length === 0)
        .map(([name]) => name);
      expect(missing, `canaries never reached the agent's requests (did it read the file?).${diag}`).toEqual([]);

      // The proof: no canary, registered or detector-only, in anything ficta forwarded.
      const leaked = Object.entries(CANARIES).flatMap(([name, value]) =>
        filesContaining(run.sent, value).map((file) => `${name} in ${file}`),
      );
      expect(leaked, `planted secrets were forwarded upstream.${diag}`).toEqual([]);

      // And the audit, which every user can run on their own traces, must agree.
      const report = await auditLogs(run.logDir);
      expect(auditLeakCount(report), formatAuditReport(report)).toBe(0);
    });
  }
});
