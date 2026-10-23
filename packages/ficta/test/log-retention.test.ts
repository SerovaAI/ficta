import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybePruneLogs, pruneLogs, scanLogUnits } from "../src/log-retention.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-23T12:00:00Z");
const DEAD_PID = 999_999;
const LIVE_PID = 4242;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ficta-log-retention-"));
  roots.push(root);
  return root;
}

/** Write `bytes` bytes at `path`, last modified `ageMs` before NOW. */
function file(path: string, bytes: number, ageMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
}

function age(dir: string, ageMs: number): void {
  const at = (NOW - ageMs) / 1000;
  utimesSync(dir, at, at);
}

function agentInstance(root: string, pid: number, ageMs: number, files: Record<string, number> = {}): string {
  const dir = join(root, "agents", "claude", `2026-10-01T00-00-00-000Z-${pid}`);
  const run = join(dir, "runs", "run-2026-10-01T00-00-00-000Z");
  file(join(run, "req-0001.meta.json"), 100, ageMs);
  for (const [name, bytes] of Object.entries(files)) file(join(run, name), bytes, ageMs);
  age(run, ageMs);
  age(join(dir, "runs"), ageMs);
  age(dir, ageMs);
  return dir;
}

const opts = { now: NOW, isPidAlive: (pid: number) => pid === LIVE_PID };

describe("log retention", () => {
  it("removes idle capture dirs past max age but keeps live and recently active ones", async () => {
    const root = tempRoot();
    const expired = agentInstance(root, DEAD_PID, 20 * DAY);
    const liveButOld = agentInstance(root, LIVE_PID, 20 * DAY);
    const recent = join(root, "agents", "codex", `2026-10-23T11-30-00-000Z-${DEAD_PID}`);
    file(join(recent, "runs", "run-x", "req-0001.meta.json"), 100, 10 * 60 * 1000);
    age(recent, 10 * 60 * 1000);
    const gatewayRun = join(root, "gateway", "runs", "run-2026-09-01T00-00-00-000Z");
    file(join(gatewayRun, "req-0001.meta.json"), 100, 30 * DAY);
    age(gatewayRun, 30 * DAY);

    const result = await pruneLogs(root, { maxAgeMs: 14 * DAY }, opts);

    expect(existsSync(expired)).toBe(false);
    expect(existsSync(gatewayRun)).toBe(false);
    expect(existsSync(liveButOld)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(result.removedUnits).toBe(2);
  });

  it("drops raw-value trace files past their own age while keeping values-free metadata", async () => {
    const root = tempRoot();
    const dir = agentInstance(root, LIVE_PID, 2 * DAY, {
      "req-0001.json": 10,
      "req-0001.sent.json": 10,
      "res-0001.txt": 10,
      "res-0001.restored.txt": 10,
      "audit-0001.trace.json": 10,
      "res-0001.meta.json": 10,
      "res-0001.restore.meta.json": 10,
    });

    const result = await pruneLogs(root, { maxAgeMs: 14 * DAY, traceMaxAgeMs: DAY }, opts);

    const run = join(dir, "runs", "run-2026-10-01T00-00-00-000Z");
    expect(result.removedTraceFiles).toBe(5);
    for (const name of ["req-0001.json", "req-0001.sent.json", "res-0001.txt", "res-0001.restored.txt"]) {
      expect(existsSync(join(run, name))).toBe(false);
    }
    expect(existsSync(join(run, "audit-0001.trace.json"))).toBe(false);
    expect(existsSync(join(run, "req-0001.meta.json"))).toBe(true);
    expect(existsSync(join(run, "res-0001.meta.json"))).toBe(true);
    expect(existsSync(join(run, "res-0001.restore.meta.json"))).toBe(true);
  });

  it("enforces the total size cap oldest-first and never removes a live dir to meet it", async () => {
    const root = tempRoot();
    const oldest = agentInstance(root, DEAD_PID, 5 * DAY, { "big.meta.json": 4000 });
    const middle = join(root, "agents", "claude", `2026-10-02T00-00-00-000Z-${DEAD_PID - 1}`);
    file(join(middle, "runs", "run-x", "big.meta.json"), 4000, 3 * DAY);
    age(middle, 3 * DAY);
    const live = join(root, "agents", "claude", `2026-09-01T00-00-00-000Z-${LIVE_PID}`);
    file(join(live, "runs", "run-x", "big.meta.json"), 4000, 9 * DAY);
    age(live, 9 * DAY);

    await pruneLogs(root, { maxTotalBytes: 9000 }, opts);

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  it("meets the size cap by dropping raw traces before any values-free history", async () => {
    const root = tempRoot();
    const history = agentInstance(root, DEAD_PID, 10 * DAY, { "res-0001.meta.json": 1000 });
    const traced = agentInstance(root, LIVE_PID, 2 * HOUR, { "req-0001.json": 3000, "res-0001.txt": 3000 });

    const result = await pruneLogs(root, { maxTotalBytes: 5000 }, opts);

    const run = join(traced, "runs", "run-2026-10-01T00-00-00-000Z");
    expect(existsSync(history)).toBe(true);
    expect(result).toMatchObject({ removedUnits: 0, removedTraceFiles: 1 });
    expect(existsSync(join(run, "req-0001.json")) !== existsSync(join(run, "res-0001.txt"))).toBe(true);
  });

  it("does not follow symlinks out of the log tree", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    file(join(outside, "precious.txt"), 10, 30 * DAY);
    file(join(outside, "req-0001.json"), 10, 30 * DAY);
    const dir = agentInstance(root, DEAD_PID, 20 * DAY);
    symlinkSync(outside, join(dir, "runs", "linked"));
    const at = (NOW - 20 * DAY) / 1000;
    lutimesSync(join(dir, "runs", "linked"), at, at);
    age(dir, 20 * DAY);

    await pruneLogs(root, { maxAgeMs: 14 * DAY, traceMaxAgeMs: 0 }, opts);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(existsSync(join(outside, "req-0001.json"))).toBe(true);
  });

  it("scans the flat legacy runs dir as its own group", async () => {
    const root = tempRoot();
    file(join(root, "runs", "run-a", "req-0001.meta.json"), 100, DAY);
    file(join(root, "ficta.log"), 100, DAY);

    const units = await scanLogUnits(root, opts);

    expect(units.map((unit) => unit.group)).toEqual(["runs"]);
  });

  it("prunes at most once per interval across launches", async () => {
    const root = tempRoot();
    const first = agentInstance(root, DEAD_PID, 20 * DAY);
    expect(await maybePruneLogs(root, { maxAgeMs: 14 * DAY }, opts)).toMatchObject({ removedUnits: 1 });
    expect(existsSync(first)).toBe(false);

    const second = agentInstance(root, DEAD_PID - 1, 20 * DAY);
    expect(await maybePruneLogs(root, { maxAgeMs: 14 * DAY }, opts)).toBeUndefined();
    expect(existsSync(second)).toBe(true);

    const anHourLater = { ...opts, now: NOW + HOUR };
    expect(await maybePruneLogs(root, { maxAgeMs: 14 * DAY }, anHourLater)).toMatchObject({ removedUnits: 1 });
  });
});
