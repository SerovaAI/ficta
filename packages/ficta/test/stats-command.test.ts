import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectionHit, ProtectionStatsEvent, ProtectionStatsSnapshot } from "@serovaai/ficta-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseStatsArgs, readStatsSources, renderStatsRollup, rollUpStats } from "../src/stats-command.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ficta-stats-"));
  roots.push(root);
  return root;
}

interface EventSpec {
  at: string;
  /** Redacted values, all carrying `label`. */
  redacted: number;
  /** Values left in the request; kept out of the model only when the request was blocked. */
  surviving?: number;
  blocked?: boolean;
  model?: string;
  label?: { name: string; source: string };
}

function hits(count: number, label: { name: string; source: string }): ProtectionHit[] {
  return Array.from({ length: count }, () => ({ name: label.name, source: label.source }) as ProtectionHit);
}

/**
 * A snapshot built from events. The per-run totals and buckets are deliberately wrong (all zero)
 * so the tests prove the rollup is built from the events, not the run-level summaries.
 */
function snapshot(startedAt: string, events: EventSpec[], restored = 0): ProtectionStatsSnapshot {
  const label = { name: "opaque-secret", source: "secret-shape" };
  return {
    version: 1,
    path: "/unused",
    startedAt,
    updatedAt: events.at(-1)?.at ?? startedAt,
    totals: {
      events: events.length,
      affectedRequests: 0,
      redactedValues: 0,
      survivingValues: 0,
      blockedRequests: 0,
      keptOutOfModelValues: 0,
      restoredValues: restored,
      withheldFromToolsValues: 0,
      residualSurrogateValues: 0,
      ambiguousEntityLinks: 0,
      ambiguousEntityLinkRequests: 0,
    },
    byModel: [],
    bySurface: [],
    byWire: [],
    byLabel: [],
    events: events.map((spec, i): ProtectionStatsEvent => ({
      index: i + 1,
      requestId: i + 1,
      at: spec.at,
      method: "POST",
      path: "/v1/messages",
      wire: "anthropic",
      model: spec.model ?? "claude-opus-5-5",
      surface: "body",
      redactedValues: spec.redacted,
      survivingValues: spec.surviving ?? 0,
      blocked: spec.blocked ?? false,
      ambiguousEntityLinks: 0,
      redactedHits: hits(spec.redacted, spec.label ?? label),
      survivingHits: hits(spec.surviving ?? 0, spec.label ?? label),
    })),
  };
}

function writeStats(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

describe("ficta stats", () => {
  it("rolls every per-run stats file under the log root into one view", async () => {
    const root = tempRoot();
    const claudeA = join(root, "agents", "claude", "2026-10-20T11-00-00-000Z-111");
    const claudeB = join(root, "agents", "claude", "2026-10-21T11-00-00-000Z-222");
    writeStats(
      join(claudeA, "runs", "run-1", "stats.json"),
      snapshot("2026-10-20T11:00:00Z", [{ at: "2026-10-20T11:05:00Z", redacted: 5 }]),
    );
    // A restarted proxy: second run in the same session.
    writeStats(
      join(claudeA, "runs", "run-2", "stats.json"),
      snapshot("2026-10-20T12:00:00Z", [{ at: "2026-10-20T12:05:00Z", redacted: 3 }], 2),
    );
    // The instance-level copy repeats the latest run and must not be double counted.
    writeStats(
      join(claudeA, "protection-stats.json"),
      snapshot("2026-10-20T12:00:00Z", [{ at: "2026-10-20T12:05:00Z", redacted: 3 }]),
    );
    writeStats(
      join(claudeB, "runs", "run-1", "stats.json"),
      snapshot("2026-10-21T11:00:00Z", [
        { at: "2026-10-21T11:05:00Z", redacted: 10, label: { name: "API_TOKEN", source: "doppler" } },
      ]),
    );
    writeStats(
      join(root, "gateway", "runs", "run-2026-10-21", "stats.json"),
      snapshot("2026-10-21T13:00:00Z", [
        { at: "2026-10-21T13:05:00Z", redacted: 2, surviving: 2, blocked: true, model: "gpt-sol" },
      ]),
    );
    writeStats(
      join(root, "agents", "codex", "2026-10-21T09-00-00-000Z-333", "runs", "run-1", "stats.json"),
      "{not json",
    );
    // A session that protected nothing writes no stats file but still counts as logged.
    mkdirSync(join(root, "agents", "codex", "2026-10-21T10-00-00-000Z-444", "runs", "run-1"), { recursive: true });

    const { sources, sessions, unreadable } = await readStatsSources(root);
    const rollup = rollUpStats(sources, { root, unreadable, sessions });

    expect(rollup.runs).toBe(4);
    expect(rollup.sessions).toBe(3);
    expect(rollup.sessionsLogged).toBe(5);
    expect(rollup.unreadable).toBe(1);
    expect(rollup.totals.keptOutOfModelValues).toBe(22);
    expect(rollup.totals.affectedRequests).toBe(4);
    expect(rollup.totals.restoredValues).toBe(2);
    expect(rollup.totals.blockedRequests).toBe(1);
    expect(
      rollup.byAgent.map((row) => [row.name, row.sessions, row.sessionsLogged, row.runs, row.keptOutOfModelValues]),
    ).toEqual([
      ["claude", 2, 2, 3, 18],
      ["gateway", 1, 1, 1, 4],
      ["codex", 0, 2, 0, 0],
    ]);
    expect(rollup.byLabel.map((row) => [row.name, row.source, row.runs, row.keptOutOfModelValues])).toEqual([
      ["opaque-secret", "secret-shape", 3, 12],
      ["API_TOKEN", "doppler", 1, 10],
    ]);
    expect(rollup.byModel.map((row) => row.name)).toEqual(["claude-opus-5-5", "gpt-sol"]);
    expect(rollup.byDay).toEqual([
      { day: "2026-10-20", runs: 2, keptOutOfModelValues: 8, blockedRequests: 0 },
      { day: "2026-10-21", runs: 2, keptOutOfModelValues: 14, blockedRequests: 1 },
    ]);
    expect(rollup.firstAt).toBe("2026-10-20T11:05:00Z");

    const text = renderStatsRollup(rollup);
    expect(text).toContain("kept 22 protected values out of the model");
    expect(text).toContain("3 of 5 sessions protected something, 4 proxy runs, 2026-10-20 → 2026-10-21");
    // Blocked surviving values never reached the model.
    expect(text).toContain("values that reached the model: 0");
    expect(text).toContain("skipped 1 unreadable stats file(s)");
  });

  it("dates protection by each event, so a long-running session spreads across days", async () => {
    const root = tempRoot();
    const session = join(root, "agents", "claude", "2026-10-20T11-00-00-000Z-111");
    writeStats(
      join(session, "runs", "run-1", "stats.json"),
      snapshot("2026-10-20T11:00:00Z", [
        { at: "2026-10-20T11:05:00Z", redacted: 5 },
        { at: "2026-10-22T09:00:00Z", redacted: 7 },
        { at: "2026-10-23T09:00:00Z", redacted: 1, label: { name: "NODE_ENV", source: "doppler" } },
      ]),
    );

    const { sources } = await readStatsSources(root);
    const all = rollUpStats(sources, { root });
    expect(all.byDay.map((row) => [row.day, row.keptOutOfModelValues])).toEqual([
      ["2026-10-20", 5],
      ["2026-10-22", 7],
      ["2026-10-23", 1],
    ]);

    // --since keeps the later events of a session that started before the cut-off.
    const since = rollUpStats(sources, { root, since: "2026-10-22" });
    expect(since.runs).toBe(1);
    expect(since.totals.keptOutOfModelValues).toBe(8);
    expect(since.totals.affectedRequests).toBe(2);
    expect(since.firstAt).toBe("2026-10-22T09:00:00Z");
    expect(since.byLabel.map((row) => [row.name, row.keptOutOfModelValues])).toEqual([
      ["opaque-secret", 7],
      ["NODE_ENV", 1],
    ]);
    expect(renderStatsRollup(since)).toContain("since 2026-10-22");

    // A run whose events all fall before the cut-off drops out entirely.
    expect(rollUpStats(sources, { root, since: "2026-10-24" }).runs).toBe(0);
  });

  it("reports an empty log root without failing", async () => {
    const root = tempRoot();
    const { sources, sessions } = await readStatsSources(root);
    const text = renderStatsRollup(rollUpStats(sources, { root, sessions }));
    expect(text).toContain("no protection activity recorded");
  });

  it("parses --since as days or a date and rejects anything else", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(parseStatsArgs(["--since", "7d"], now)).toEqual({ ok: true, json: false, since: "2026-10-27" });
    expect(parseStatsArgs(["--since=2026-10-01", "--json"], now)).toEqual({
      ok: true,
      json: true,
      since: "2026-10-01",
    });
    expect(parseStatsArgs(["--since", "last-week"], now).ok).toBe(false);
    expect(parseStatsArgs(["--since"], now).ok).toBe(false);
    expect(parseStatsArgs(["--verbose"], now).ok).toBe(false);
  });
});
