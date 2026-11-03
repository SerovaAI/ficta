import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ProtectionHit, ProtectionStatsSnapshot } from "@serovaai/ficta-protocol";
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
  /** Sessions with protection activity in range. */
  sessions: number;
  /** Every session of this agent active in range, including ones that protected nothing. */
  sessionsLogged: number;
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
  /** Sessions (agent launches, or gateway runs) with protection activity in range. */
  sessions: number;
  /** Every session under the log root active in range, including ones that protected nothing. */
  sessionsLogged: number;
  /** Proxy runs with activity in range; one session can hold several when its proxy restarts. */
  runs: number;
  /** Earliest and latest protection event in range. */
  firstAt?: string;
  lastAt?: string;
  /** Stats files that could not be read or did not look like a snapshot. */
  unreadable: number;
  totals: StatsTotals;
  byAgent: StatsAgentRow[];
  byModel: StatsRow[];
  bySurface: StatsRow[];
  byLabel: StatsLabelRow[];
  /** Keyed by each event's own UTC day, so a long-running session spreads across the days it ran. */
  byDay: StatsDayRow[];
}

export interface StatsSource {
  /** Log group: `agents/<agent>`, a role such as `gateway`, or `runs`. */
  group: string;
  /** Session dir the run belongs to (agent instance dir, or the run dir itself). */
  session: string;
  snapshot: ProtectionStatsSnapshot;
}

/** One session dir under the log root, whether or not it wrote any stats. */
export interface StatsSession {
  group: string;
  session: string;
  lastActivityMs: number;
}

export async function runStatsCommand(args: readonly string[]): Promise<number> {
  const parsed = parseStatsArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`ficta stats: ${parsed.error}\nusage: ficta stats [--since <Nd|YYYY-MM-DD>] [--json]\n`);
    return 2;
  }
  const cfg = loadConfig();
  const { sources, sessions, unreadable } = await readStatsSources(cfg.logRoot);
  const rollup = rollUpStats(sources, { root: cfg.logRoot, since: parsed.since, unreadable, sessions });
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

/** Every per-run `stats.json` under `root`, plus every session dir (so idle sessions are counted). */
export async function readStatsSources(
  root: string,
): Promise<{ sources: StatsSource[]; sessions: StatsSession[]; unreadable: number }> {
  const sources: StatsSource[] = [];
  const sessions: StatsSession[] = [];
  let unreadable = 0;
  for (const unit of await scanLogUnits(root)) {
    sessions.push({ group: unit.group, session: unit.path, lastActivityMs: unit.lastActivityMs });
    for (const file of unit.files) {
      // Per-run copies only: an instance's top-level protection-stats.json repeats its latest run.
      if (basename(file.path) !== "stats.json" || !basename(dirname(file.path)).startsWith("run-")) continue;
      const snapshot = await readSnapshot(file.path);
      if (snapshot) sources.push({ group: unit.group, session: unit.path, snapshot });
      else unreadable += 1;
    }
  }
  return { sources, sessions, unreadable };
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
    Array.isArray(v.events)
  );
}

interface MutableRow extends StatsRow {
  runKeys: Set<string>;
  requestKeys: Set<string>;
  blockedKeys: Set<string>;
}

/**
 * Build the rollup from each run's timestamped events rather than its per-run totals, so `--since`
 * and the day breakdown count protection when it happened, not when the session started. Restore
 * counts are only kept as per-run totals; they are included for every run with activity in range.
 */
export function rollUpStats(
  sources: readonly StatsSource[],
  opts: { root: string; since?: string; unreadable?: number; sessions?: readonly StatsSession[] },
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
  const all = newRow("all");
  const agents = new Map<string, MutableRow & { sessionSet: Set<string>; logged: number }>();
  const models = new Map<string, MutableRow>();
  const surfaces = new Map<string, MutableRow>();
  const labels = new Map<string, MutableRow & { source: string }>();
  const days = new Map<string, MutableRow>();
  const activeSessions = new Set<string>();
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  const agentRow = (group: string) => {
    const name = agentName(group);
    const row = agents.get(name) ?? { ...newRow(name), sessionSet: new Set<string>(), logged: 0 };
    agents.set(name, row);
    return row;
  };
  const sinceMs = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) : undefined;
  for (const session of opts.sessions ?? []) {
    if (sinceMs === undefined || session.lastActivityMs >= sinceMs) agentRow(session.group).logged += 1;
  }

  sources.forEach(({ group, session, snapshot }, runIndex) => {
    const run = `run:${runIndex}`;
    const inRange = snapshot.events.filter((event) => !opts.since || dayOf(event.at) >= opts.since);
    // A run with only restore activity has no events; count it when it is not being date-filtered.
    const restoreOnly = snapshot.events.length === 0 && !opts.since;
    if (inRange.length === 0 && !restoreOnly) return;

    activeSessions.add(session);
    const agent = agentRow(group);
    agent.sessionSet.add(session);
    agent.runKeys.add(run);
    all.runKeys.add(run);
    const t = snapshot.totals;
    totals.restoredValues += num(t.restoredValues);
    totals.withheldFromToolsValues += num(t.withheldFromToolsValues);
    totals.residualSurrogateValues += num(t.residualSurrogateValues);

    for (const event of inRange) {
      const request = `${run}:${event.requestId === undefined ? `event:${event.index}` : `request:${event.requestId}`}`;
      const redacted = num(event.redactedValues);
      const surviving = num(event.survivingValues);
      const kept = redacted + (event.blocked ? surviving : 0);
      totals.redactedValues += redacted;
      totals.survivingValues += surviving;
      totals.keptOutOfModelValues += kept;
      totals.ambiguousEntityLinks += num(event.ambiguousEntityLinks);
      if (!firstAt || event.at < firstAt) firstAt = event.at;
      if (!lastAt || event.at > lastAt) lastAt = event.at;

      const touch = (row: MutableRow, keptOut: number, survivingValues: number) => {
        row.runKeys.add(run);
        row.requestKeys.add(request);
        row.keptOutOfModelValues += keptOut;
        row.survivingValues += survivingValues;
        if (event.blocked) row.blockedKeys.add(request);
      };
      touch(all, kept, surviving);
      touch(agent, kept, surviving);
      touch(rowFor(models, event.model || "unknown"), kept, surviving);
      touch(rowFor(surfaces, event.surface || "unknown"), kept, surviving);
      touch(rowFor(days, dayOf(event.at)), kept, surviving);
      for (const hit of event.redactedHits ?? []) touch(labelRow(labels, hit), 1, 0);
      for (const hit of event.survivingHits ?? []) touch(labelRow(labels, hit), event.blocked ? 1 : 0, 1);
    }
  });

  totals.affectedRequests = all.requestKeys.size;
  totals.blockedRequests = all.blockedKeys.size;
  const rollup: StatsRollup = {
    root: opts.root,
    sessions: activeSessions.size,
    sessionsLogged: Math.max(
      activeSessions.size,
      [...agents.values()].reduce((sum, row) => sum + Math.max(row.logged, row.sessionSet.size), 0),
    ),
    runs: all.runKeys.size,
    unreadable: opts.unreadable ?? 0,
    totals,
    byAgent: [...agents.values()]
      .filter((row) => row.sessionSet.size > 0 || row.logged > 0)
      .map((row) => ({
        ...freeze(row),
        sessions: row.sessionSet.size,
        sessionsLogged: Math.max(row.logged, row.sessionSet.size),
      }))
      .sort(compareRows),
    byModel: [...models.values()].map(freeze).sort(compareRows),
    bySurface: [...surfaces.values()].map(freeze).sort(compareRows),
    byLabel: [...labels.values()].map((row) => ({ ...freeze(row), source: row.source })).sort(compareRows),
    byDay: [...days.values()]
      .map((row) => ({
        day: row.name,
        runs: row.runKeys.size,
        keptOutOfModelValues: row.keptOutOfModelValues,
        blockedRequests: row.blockedKeys.size,
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
  if (opts.since) rollup.since = opts.since;
  if (firstAt) rollup.firstAt = firstAt;
  if (lastAt) rollup.lastAt = lastAt;
  return rollup;
}

function newRow(name: string): MutableRow {
  return {
    name,
    runs: 0,
    requests: 0,
    keptOutOfModelValues: 0,
    survivingValues: 0,
    blockedRequests: 0,
    runKeys: new Set<string>(),
    requestKeys: new Set<string>(),
    blockedKeys: new Set<string>(),
  };
}

function rowFor(rows: Map<string, MutableRow>, name: string): MutableRow {
  const row = rows.get(name) ?? newRow(name);
  rows.set(name, row);
  return row;
}

function labelRow(rows: Map<string, MutableRow & { source: string }>, hit: ProtectionHit): MutableRow {
  const name = hit.name || "<unknown>";
  const source = hit.source || "unknown";
  const key = `${name}\0${source}`;
  const row = rows.get(key) ?? { ...newRow(name), source };
  rows.set(key, row);
  return row;
}

function freeze(row: MutableRow): StatsRow {
  return {
    name: row.name,
    runs: row.runKeys.size,
    requests: row.requestKeys.size,
    keptOutOfModelValues: row.keptOutOfModelValues,
    survivingValues: row.survivingValues,
    blockedRequests: row.blockedKeys.size,
  };
}

function agentName(group: string): string {
  return group.startsWith("agents/") ? group.slice("agents/".length) : group;
}

function dayOf(at: string): string {
  return at.slice(0, 10);
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
    const logged = rollup.sessionsLogged > 0 ? ` (${n(rollup.sessionsLogged)} sessions logged)` : "";
    lines.push(`  no protection activity recorded under ${rollup.root}${logged}`);
    if (opts.retention) lines.push(`  retention: ${opts.retention}`);
    return `${lines.join("\n")}\n`;
  }

  const span =
    rollup.firstAt && rollup.lastAt ? `, ${rollup.firstAt.slice(0, 10)} → ${rollup.lastAt.slice(0, 10)}` : "";
  lines.push(
    `  ${n(rollup.sessions)} of ${n(rollup.sessionsLogged)} sessions protected something, ${n(rollup.runs)} proxy runs${span}`,
  );
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
      rollup.byAgent.map((row) => [
        row.name,
        `${n(row.sessions)} of ${n(row.sessionsLogged)} sessions`,
        n(row.keptOutOfModelValues),
      ]),
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
  if (rollup.totals.restoredValues + rollup.totals.withheldFromToolsValues > 0 && rollup.since) {
    lines.push("restore counts cover whole runs with activity in range; they carry no per-event dates");
  }
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
