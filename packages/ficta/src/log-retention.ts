import { lstat, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// Log retention for the capture tree under the log root. Every agent launch leaves an instance dir
// (agents/<agent>/<iso>-<pid>/) and every standalone proxy a run dir (<role>/runs/run-<iso>/); without
// pruning they accumulate forever, and trace captures hold raw protected values in plaintext. Units
// that may still be written to — an instance whose process is alive, or anything touched within the
// last hour — are never deleted whole, so concurrent launches cannot prune each other.

/** Raw-value capture files, written only under trace capture (log.ts, server.ts). Everything else is values-free metadata. */
const RAW_CAPTURE_FILE = /^(?:req-\d+(?:\.sent)?\.json|res-\d+(?:\.restored)?\.txt|audit-\d+\.trace\.json)$/;
/** Agent instance dir name: `<iso timestamp with : and . replaced>-<pid>` (cli.ts logInstanceId). */
const INSTANCE_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(\d+)$/;
const PRUNE_STAMP = ".prune-stamp";
const RECENT_ACTIVITY_MS = 60 * 60 * 1000;
export const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface LogRetentionPolicy {
  /** Delete a unit idle longer than this; undefined keeps units regardless of age. */
  maxAgeMs?: number;
  /** Delete the oldest idle units until the tree is at or below this; undefined disables the cap. */
  maxTotalBytes?: number;
  /** Delete raw-value capture files at least this old (0 deletes them all); undefined keeps them. */
  traceMaxAgeMs?: number;
}

interface LogFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface LogUnit {
  path: string;
  /** `agents/<agent>`, `<role>` (e.g. `gateway`), or `runs` for the flat layout. */
  group: string;
  live: boolean;
  lastActivityMs: number;
  bytes: number;
  files: LogFile[];
}

export interface PruneResult {
  removedUnits: number;
  removedTraceFiles: number;
  freedBytes: number;
}

export interface PruneOptions {
  now?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** Every instance/run dir under `root`, with its files, size, and whether it may still be in use. */
export async function scanLogUnits(root: string, opts: PruneOptions = {}): Promise<LogUnit[]> {
  const now = opts.now ?? Date.now();
  const isPidAlive = opts.isPidAlive ?? pidAlive;
  const units: LogUnit[] = [];
  for (const agent of await subdirs(join(root, "agents"))) {
    for (const instance of await subdirs(join(root, "agents", agent))) {
      const pid = Number(INSTANCE_NAME.exec(instance)?.[1] ?? NaN);
      const alive = Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
      units.push(await scanUnit(join(root, "agents", agent, instance), `agents/${agent}`, alive, now));
    }
  }
  for (const role of await subdirs(root)) {
    if (role === "agents") continue;
    const runsDir = role === "runs" ? join(root, "runs") : join(root, role, "runs");
    for (const run of await subdirs(runsDir)) {
      if (!run.startsWith("run-")) continue;
      units.push(await scanUnit(join(runsDir, run), role, false, now));
    }
  }
  return units;
}

/** Apply `policy` to the tree under `root` now. Missing dirs and concurrent deletes are not errors. */
export async function pruneLogs(
  root: string,
  policy: LogRetentionPolicy,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const result: PruneResult = { removedUnits: 0, removedTraceFiles: 0, freedBytes: 0 };
  const kept: LogUnit[] = [];
  for (const unit of await scanLogUnits(root, opts)) {
    if (!unit.live && policy.maxAgeMs !== undefined && now - unit.lastActivityMs > policy.maxAgeMs) {
      await removeUnit(unit, result);
      continue;
    }
    if (policy.traceMaxAgeMs !== undefined) {
      for (const file of traceFiles(unit)) {
        if (now - file.mtimeMs >= policy.traceMaxAgeMs) await removeTraceFile(unit, file, result);
      }
    }
    kept.push(unit);
  }
  if (policy.maxTotalBytes !== undefined) {
    let total = kept.reduce((sum, unit) => sum + unit.bytes, 0);
    // Raw traces dominate the tree under dev trace and are the sensitive part, so they go first
    // (oldest first, any unit); whole idle dirs — values-free history — only if that is not enough.
    const traces = kept
      .flatMap((unit) => traceFiles(unit).map((file) => ({ unit, file })))
      .sort((a, b) => a.file.mtimeMs - b.file.mtimeMs);
    for (const { unit, file } of traces) {
      if (total <= policy.maxTotalBytes) break;
      total -= file.bytes;
      await removeTraceFile(unit, file, result);
    }
    const oldestFirst = kept.filter((unit) => !unit.live).sort((a, b) => a.lastActivityMs - b.lastActivityMs);
    for (const unit of oldestFirst) {
      if (total <= policy.maxTotalBytes) break;
      total -= unit.bytes;
      await removeUnit(unit, result);
    }
  }
  return result;
}

/**
 * {@link pruneLogs}, at most once per `intervalMs` across every process sharing `root` (a stamp file
 * records the last pass). Agent launches call this in the background, so it never throws.
 */
export async function maybePruneLogs(
  root: string,
  policy: LogRetentionPolicy,
  opts: PruneOptions & { intervalMs?: number } = {},
): Promise<PruneResult | undefined> {
  const now = opts.now ?? Date.now();
  const stampPath = join(root, PRUNE_STAMP);
  try {
    const last = await stat(stampPath).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (now - last < (opts.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS)) return undefined;
    await writeFile(stampPath, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    await utimes(stampPath, now / 1000, now / 1000);
    return await pruneLogs(root, policy, opts);
  } catch {
    return undefined;
  }
}

/** Raw-value capture files in a unit (for `ficta logs`). */
export function traceFiles(unit: LogUnit): LogFile[] {
  return unit.files.filter((file) => RAW_CAPTURE_FILE.test(basename(file.path)));
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** One-line policy summary for doctor and `ficta logs`. */
export function describeRetention(policy: LogRetentionPolicy): string {
  const age = policy.maxAgeMs === undefined ? "kept forever" : `${Math.round(policy.maxAgeMs / 86_400_000)} days`;
  const cap = policy.maxTotalBytes === undefined ? "no size cap" : `${formatBytes(policy.maxTotalBytes)} cap`;
  const traces =
    policy.traceMaxAgeMs === undefined
      ? "raw traces kept with their run"
      : `raw traces ${Math.round(policy.traceMaxAgeMs / 3_600_000)} h`;
  return `${age} · ${cap} · ${traces}`;
}

async function scanUnit(path: string, group: string, alive: boolean, now: number): Promise<LogUnit> {
  const files: LogFile[] = [];
  let lastActivityMs = await lstat(path).then(
    (s) => s.mtimeMs,
    () => 0,
  );
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Dirent types come from lstat: symlinks are neither followed nor treated as dirs.
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const s = await lstat(full).catch(() => undefined);
      if (!s) continue;
      files.push({ path: full, bytes: s.size, mtimeMs: s.mtimeMs });
      lastActivityMs = Math.max(lastActivityMs, s.mtimeMs);
    }
  };
  await walk(path);
  return {
    path,
    group,
    live: alive || now - lastActivityMs < RECENT_ACTIVITY_MS,
    lastActivityMs,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

async function removeTraceFile(unit: LogUnit, file: LogFile, result: PruneResult): Promise<void> {
  await rm(file.path, { force: true }).catch(() => undefined);
  unit.files = unit.files.filter((other) => other !== file);
  unit.bytes -= file.bytes;
  result.removedTraceFiles += 1;
  result.freedBytes += file.bytes;
}

async function removeUnit(unit: LogUnit, result: PruneResult): Promise<void> {
  await rm(unit.path, { recursive: true, force: true }).catch(() => undefined);
  result.removedUnits += 1;
  result.freedBytes += unit.bytes;
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
