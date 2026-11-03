import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectionStatsSnapshot } from "@serovaai/ficta-protocol";
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

function snapshot(opts: {
  startedAt: string;
  kept: number;
  surviving?: number;
  blocked?: number;
  restored?: number;
  model?: string;
  label?: { name: string; source: string };
}): ProtectionStatsSnapshot {
  const surviving = opts.surviving ?? 0;
  const blocked = opts.blocked ?? 0;
  const redacted = opts.kept - (blocked > 0 ? surviving : 0);
  const bucket = (name: string) => ({
    name,
    requests: 1,
    redactedValues: redacted,
    survivingValues: surviving,
    blockedRequests: blocked,
    keptOutOfModelValues: opts.kept,
  });
  const label = opts.label ?? { name: "opaque-secret", source: "secret-shape" };
  return {
    version: 1,
    path: "/unused",
    startedAt: opts.startedAt,
    updatedAt: opts.startedAt,
    totals: {
      events: 1,
      affectedRequests: 1,
      redactedValues: redacted,
      survivingValues: surviving,
      blockedRequests: blocked,
      keptOutOfModelValues: opts.kept,
      restoredValues: opts.restored ?? 0,
      withheldFromToolsValues: 0,
      residualSurrogateValues: 0,
      ambiguousEntityLinks: 0,
      ambiguousEntityLinkRequests: 0,
    },
    byModel: [bucket(opts.model ?? "claude-opus-5-5")],
    bySurface: [bucket("body")],
    byWire: [bucket("anthropic")],
    byLabel: [{ ...bucket(label.name), source: label.source }],
    events: [],
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
    writeStats(join(claudeA, "runs", "run-1", "stats.json"), snapshot({ startedAt: "2026-10-20T11:00:00Z", kept: 5 }));
    // A restarted proxy: second run in the same session.
    writeStats(
      join(claudeA, "runs", "run-2", "stats.json"),
      snapshot({ startedAt: "2026-10-20T12:00:00Z", kept: 3, restored: 2 }),
    );
    // The instance-level copy repeats the latest run and must not be double counted.
    writeStats(join(claudeA, "protection-stats.json"), snapshot({ startedAt: "2026-10-20T12:00:00Z", kept: 3 }));
    writeStats(
      join(claudeB, "runs", "run-1", "stats.json"),
      snapshot({ startedAt: "2026-10-21T11:00:00Z", kept: 10, label: { name: "API_TOKEN", source: "doppler" } }),
    );
    writeStats(
      join(root, "gateway", "runs", "run-2026-10-21", "stats.json"),
      snapshot({ startedAt: "2026-10-21T13:00:00Z", kept: 4, surviving: 2, blocked: 1, model: "gpt-sol" }),
    );
    writeStats(
      join(root, "agents", "codex", "2026-10-21T09-00-00-000Z-333", "runs", "run-1", "stats.json"),
      "{not json",
    );

    const { sources, unreadable } = await readStatsSources(root);
    const rollup = rollUpStats(sources, { root, unreadable });

    expect(rollup.runs).toBe(4);
    expect(rollup.sessions).toBe(3);
    expect(rollup.unreadable).toBe(1);
    expect(rollup.totals.keptOutOfModelValues).toBe(22);
    expect(rollup.totals.restoredValues).toBe(2);
    expect(rollup.totals.blockedRequests).toBe(1);
    expect(rollup.byAgent.map((row) => [row.name, row.sessions, row.runs, row.keptOutOfModelValues])).toEqual([
      ["claude", 2, 3, 18],
      ["gateway", 1, 1, 4],
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
    expect(rollup.firstAt).toBe("2026-10-20T11:00:00Z");

    const text = renderStatsRollup(rollup);
    expect(text).toContain("kept 22 protected values out of the model");
    expect(text).toContain("3 sessions, 4 proxy runs, 2026-10-20 → 2026-10-21");
    // Blocked surviving values never reached the model.
    expect(text).toContain("values that reached the model: 0");
    expect(text).toContain("skipped 1 unreadable stats file(s)");
  });

  it("filters runs by start day with --since", async () => {
    const root = tempRoot();
    const session = join(root, "agents", "claude", "2026-10-20T11-00-00-000Z-111");
    writeStats(join(session, "runs", "run-1", "stats.json"), snapshot({ startedAt: "2026-10-20T11:00:00Z", kept: 5 }));
    writeStats(join(session, "runs", "run-2", "stats.json"), snapshot({ startedAt: "2026-10-22T11:00:00Z", kept: 7 }));

    const { sources } = await readStatsSources(root);
    const rollup = rollUpStats(sources, { root, since: "2026-10-21" });

    expect(rollup.runs).toBe(1);
    expect(rollup.totals.keptOutOfModelValues).toBe(7);
    expect(renderStatsRollup(rollup)).toContain("since 2026-10-21");
  });

  it("reports an empty log root without failing", async () => {
    const root = tempRoot();
    const { sources } = await readStatsSources(root);
    const text = renderStatsRollup(rollUpStats(sources, { root }));
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
