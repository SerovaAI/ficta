import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  ProtectionStatsBucket,
  ProtectionStatsLabelBucket,
  ProtectionStatsSnapshot,
} from "@serovaai/ficta-protocol";
import { loadConfig } from "./config.js";
import { describeRetention, scanLogUnits } from "./log-retention.js";

/**
 * `ficta stats [--since <Nd|YYYY-MM-DD>] [--json]` — roll every proxy run's values-free
 * `stats.json` under the log root up into one view: totals, then by agent, model, surface, label
 * and day. Reads counts and labels only; the snapshots never hold protected values.
 */

export interface StatsTotals {
  keptOutOfModelValues: number;
  redactedValues: number;
  survivingValues: number;
  affectedRequests: number;
  blockedRequests: number;
  restoredValues: number;
  withheldFromToolsValues: number;
  residualSurrogateValues: number;
  ambiguousEntityLinks: number;
}

export interface StatsRow {
  name: string;
  runs: number;
  requests: number;
  keptOutOfModelValues: number;
  survivingValues: number;
  blockedRequests: number;
}

export interface StatsAgentRow extends StatsRow {
  sessions: number;
}

export interface StatsLabelRow extends StatsRow {
  source: string;
}

export interface StatsDayRow {
  day: string;
  runs: number;
  keptOutOfModelValues: number;
  blockedRequests: number;
}

export interface StatsRollup {
  root: string;
  since?: string;
  /** Agent launches (or gateway runs) with at least one stats file in range. */
  sessions: number;
  /** Proxy runs; one session can hold several when its proxy restarts. */
  runs: number;
  firstAt?: string;
  lastAt?: string;
  /** Stats files that could not be read or did not look like a snapshot. */
  unreadable: number;
  totals: StatsTotals;
  byAgent: StatsAgentRow[];
  byModel: StatsRow[];
  bySurface: StatsRow[];
  byLabel: StatsLabelRow[];
  byDay: StatsDayRow[];
}

export interface StatsSource {
  /** Log group: `agents/<agent>`, a role such as `gateway`, or `runs`. */
  group: string;
  /** Session dir the run belongs to (agent instance dir, or the run dir itself). */
  session: string;
  snapshot: ProtectionStatsSnapshot;
}

export async function runStatsCommand(args: readonly string[]): Promise<number> {
  const parsed = parseStatsArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`ficta stats: ${parsed.error}\nusage: ficta stats [--since <Nd|YYYY-MM-DD>] [--json]\n`);
    return 2;
  }
  const cfg = loadConfig();
  const { sources, unreadable } = await readStatsSources(cfg.logRoot);
  const rollup = rollUpStats(sources, { root: cfg.logRoot, since: parsed.since, unreadable });
  process.stdout.write(
    parsed.json
      ? `${JSON.stringify(rollup, null, 2)}\n`
      : renderStatsRollup(rollup, { retention: describeRetention(cfg.logRetention) }),
  );
  return 0;
}

type ParsedArgs = { ok: true; json: boolean; since?: string } | { ok: false; error: string };

export function parseStatsArgs(args: readonly string[], now: number = Date.now()): ParsedArgs {
  let json = false;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    const inline = arg?.startsWith("--since=") ? arg.slice("--since=".length) : undefined;
    if (arg === "--since" || inline !== undefined) {
      const raw = inline ?? args[++i];
      const resolved = raw === undefined ? undefined : resolveSince(raw, now);
      if (!resolved) return { ok: false, error: `--since needs <N>d or YYYY-MM-DD, got ${raw ?? "nothing"}` };
      since = resolved;
      continue;
    }
    return { ok: false, error: `unknown argument ${arg}` };
  }
  return since === undefined ? { ok: true, json } : { ok: true, json, since };
}

/** `7d` → the UTC day 7 days ago; `2026-10-01` → itself. Returns a YYYY-MM-DD day or undefined. */
function resolveSince(raw: string, now: number): string | undefined {
  const days = /^(\d{1,4})d$/.exec(raw);
  if (days) return new Date(now - Number(days[1]) * 86_400_000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return raw;
  return undefined;
}

/** Every per-run `stats.json` under `root`, grouped by the log unit that holds it. */
export async function readStatsSources(root: string): Promise<{ sources: StatsSource[]; unreadable: number }> {
  const sources: StatsSource[] = [];
  let unreadable = 0;
  for (const unit of await scanLogUnits(root)) {
    for (const file of unit.files) {
      // Per-run copies only: an instance's top-level protection-stats.json repeats its latest run.
      if (basename(file.path) !== "stats.json" || !basename(dirname(file.path)).startsWith("run-")) continue;
      const snapshot = await readSnapshot(file.path);
      if (snapshot) sources.push({ group: unit.group, session: unit.path, snapshot });
      else unreadable += 1;
    }
  }
  return { sources, unreadable };
}

async function readSnapshot(path: string): Promise<ProtectionStatsSnapshot | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isSnapshot(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isSnapshot(value: unknown): value is ProtectionStatsSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.startedAt === "string" &&
    typeof v.totals === "object" &&
    v.totals !== null &&
    Array.isArray(v.byModel) &&
    Array.isArray(v.bySurface) &&
    Array.isArray(v.byLabel)
  );
}

export function rollUpStats(
  sources: readonly StatsSource[],
  opts: { root: string; since?: string; unreadable?: number },
): StatsRollup {
  const totals: StatsTotals = {
    keptOutOfModelValues: 0,
    redactedValues: 0,
    survivingValues: 0,
    affectedRequests: 0,
    blockedRequests: 0,
    restoredValues: 0,
    withheldFromToolsValues: 0,
    residualSurrogateValues: 0,
    ambiguousEntityLinks: 0,
  };
  const agents = new Map<string, StatsAgentRow & { sessionSet: Set<string> }>();
  const models = new Map<string, StatsRow>();
  const surfaces = new Map<string, StatsRow>();
  const labels = new Map<string, StatsLabelRow>();
  const days = new Map<string, StatsDayRow>();
  const sessions = new Set<string>();
  let runs = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  for (const { group, session, snapshot } of sources) {
    const day = snapshot.startedAt.slice(0, 10);
    if (opts.since && day < opts.since) continue;
    const t = snapshot.totals;
    runs += 1;
    sessions.add(session);
    if (!firstAt || snapshot.startedAt < firstAt) firstAt = snapshot.startedAt;
    const updatedAt = snapshot.updatedAt ?? snapshot.startedAt;
    if (!lastAt || updatedAt > lastAt) lastAt = updatedAt;

    totals.keptOutOfModelValues += num(t.keptOutOfModelValues);
    totals.redactedValues += num(t.redactedValues);
    totals.survivingValues += num(t.survivingValues);
    totals.affectedRequests += num(t.affectedRequests);
    totals.blockedRequests += num(t.blockedRequests);
    totals.restoredValues += num(t.restoredValues);
    totals.withheldFromToolsValues += num(t.withheldFromToolsValues);
    totals.residualSurrogateValues += num(t.residualSurrogateValues);
    totals.ambiguousEntityLinks += num(t.ambiguousEntityLinks);

    const agentName = group.startsWith("agents/") ? group.slice("agents/".length) : group;
    const agent = agents.get(agentName) ?? { ...emptyRow(agentName), sessions: 0, sessionSet: new Set<string>() };
    agents.set(agentName, agent);
    agent.sessionSet.add(session);
    addTotals(agent, t);

    for (const bucket of snapshot.byModel) addBucket(models, bucket.name, bucket);
    for (const bucket of snapshot.bySurface) addBucket(surfaces, bucket.name, bucket);
    for (const bucket of snapshot.byLabel as ProtectionStatsLabelBucket[]) {
      const source = bucket.source || "unknown";
      const key = `${bucket.name}\0${source}`;
      const row = labels.get(key) ?? { ...emptyRow(bucket.name), source };
      labels.set(key, row);
      addBucketCounts(row, bucket);
    }

    const dayRow = days.get(day) ?? { day, runs: 0, keptOutOfModelValues: 0, blockedRequests: 0 };
    days.set(day, dayRow);
    dayRow.runs += 1;
    dayRow.keptOutOfModelValues += num(t.keptOutOfModelValues);
    dayRow.blockedRequests += num(t.blockedRequests);
  }

  const rollup: StatsRollup = {
    root: opts.root,
    sessions: sessions.size,
    runs,
    unreadable: opts.unreadable ?? 0,
    totals,
    byAgent: [...agents.values()]
      .map(({ sessionSet, ...row }) => ({ ...row, sessions: sessionSet.size }))
      .sort(compareRows),
    byModel: [...models.values()].sort(compareRows),
    bySurface: [...surfaces.values()].sort(compareRows),
    byLabel: [...labels.values()].sort(compareRows),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
  if (opts.since) rollup.since = opts.since;
  if (firstAt) rollup.firstAt = firstAt;
  if (lastAt) rollup.lastAt = lastAt;
  return rollup;
}

function emptyRow(name: string): StatsRow {
  return { name, runs: 0, requests: 0, keptOutOfModelValues: 0, survivingValues: 0, blockedRequests: 0 };
}

function addTotals(row: StatsRow, t: ProtectionStatsSnapshot["totals"]): void {
  row.runs += 1;
  row.requests += num(t.affectedRequests);
  row.keptOutOfModelValues += num(t.keptOutOfModelValues);
  row.survivingValues += num(t.survivingValues);
  row.blockedRequests += num(t.blockedRequests);
}

function addBucket(rows: Map<string, StatsRow>, name: string, bucket: ProtectionStatsBucket): void {
  const key = name || "unknown";
  const row = rows.get(key) ?? emptyRow(key);
  rows.set(key, row);
  addBucketCounts(row, bucket);
}

function addBucketCounts(row: StatsRow, bucket: ProtectionStatsBucket): void {
  row.runs += 1;
  row.requests += num(bucket.requests);
  row.keptOutOfModelValues += num(bucket.keptOutOfModelValues);
  row.survivingValues += num(bucket.survivingValues);
  row.blockedRequests += num(bucket.blockedRequests);
}

function compareRows(a: StatsRow, b: StatsRow): number {
  return b.keptOutOfModelValues - a.keptOutOfModelValues || b.runs - a.runs || a.name.localeCompare(b.name);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

const TOP_MODELS = 5;
const TOP_LABELS = 10;
const RECENT_DAYS = 14;

export function renderStatsRollup(rollup: StatsRollup, opts: { retention?: string } = {}): string {
  const n = (value: number) => value.toLocaleString("en-US");
  const t = rollup.totals;
  const scope = rollup.since ? ` since ${rollup.since}` : "";
  const lines = [`ficta stats: kept ${n(t.keptOutOfModelValues)} protected values out of the model${scope}`];
  if (rollup.runs === 0) {
    lines.push(`  no protection activity recorded under ${rollup.root}`);
    if (opts.retention) lines.push(`  retention: ${opts.retention}`);
    return `${lines.join("\n")}\n`;
  }

  const span =
    rollup.firstAt && rollup.lastAt ? `, ${rollup.firstAt.slice(0, 10)} → ${rollup.lastAt.slice(0, 10)}` : "";
  lines.push(`  ${n(rollup.sessions)} sessions, ${n(rollup.runs)} proxy runs${span}`);
  lines.push(
    `  affected requests: ${n(t.affectedRequests)}, blocked: ${n(t.blockedRequests)}, values that reached the model: ${n(reachedModel(t))}`,
  );
  const restore = [`restored into responses: ${n(t.restoredValues)}`];
  if (t.withheldFromToolsValues > 0) restore.push(`withheld from tool calls: ${n(t.withheldFromToolsValues)}`);
  if (t.residualSurrogateValues > 0) restore.push(`unrestored surrogate tokens: ${n(t.residualSurrogateValues)}`);
  lines.push(`  ${restore.join(", ")}`);
  if (t.ambiguousEntityLinks > 0) lines.push(`  ambiguous entity links: ${n(t.ambiguousEntityLinks)}`);

  lines.push("", "By agent:");
  lines.push(
    ...table(
      rollup.byAgent.map((row) => [row.name, `${n(row.sessions)} sessions`, n(row.keptOutOfModelValues)]),
      [false, true, true],
    ),
  );

  const models = rollup.byModel.filter((row) => row.name !== "unknown");
  if (models.length > 0) {
    lines.push("", `By model${models.length > TOP_MODELS ? ` (top ${TOP_MODELS})` : ""}:`);
    lines.push(
      ...table(
        models.slice(0, TOP_MODELS).map((row) => [row.name, n(row.keptOutOfModelValues)]),
        [false, true],
      ),
    );
  }

  if (rollup.bySurface.length > 0) {
    lines.push("", "By surface:");
    lines.push(
      ...table(
        rollup.bySurface.map((row) => [row.name, n(row.keptOutOfModelValues)]),
        [false, true],
      ),
    );
  }

  if (rollup.byLabel.length > 0) {
    lines.push("", `Top labels${rollup.byLabel.length > TOP_LABELS ? ` (top ${TOP_LABELS})` : ""}:`);
    lines.push(
      ...table(
        rollup.byLabel.slice(0, TOP_LABELS).map((row) => [row.name, row.source, n(row.keptOutOfModelValues)]),
        [false, false, true],
      ),
    );
  }

  const recent = rollup.byDay.slice(-RECENT_DAYS);
  lines.push("", `By day${rollup.byDay.length > RECENT_DAYS ? ` (last ${RECENT_DAYS} active)` : ""}:`);
  lines.push(
    ...table(
      recent.map((row) => [row.day, `${n(row.runs)} runs`, n(row.keptOutOfModelValues)]),
      [false, true, true],
    ),
  );

  lines.push("");
  if (rollup.unreadable > 0) lines.push(`skipped ${n(rollup.unreadable)} unreadable stats file(s)`);
  lines.push(`source: ${rollup.root}${opts.retention ? ` (retention: ${opts.retention})` : ""}`);
  return `${lines.join("\n")}\n`;
}

/** Detected values left in a request that was still sent: surviving values minus those on blocked requests. */
function reachedModel(t: StatsTotals): number {
  return Math.max(0, t.redactedValues + t.survivingValues - t.keptOutOfModelValues);
}

function table(rows: readonly string[][], rightAlign: readonly boolean[]): string[] {
  const widths = rightAlign.map((_, col) => Math.max(0, ...rows.map((row) => (row[col] ?? "").length)));
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, col) => (rightAlign[col] ? cell.padStart(widths[col] ?? 0) : cell.padEnd(widths[col] ?? 0)))
        .join("  ")
        .trimEnd()}`,
  );
}
