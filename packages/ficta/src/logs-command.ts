import { loadConfig } from "./config.js";
import { auditLeakCount, auditLogs, formatAuditReport } from "./log-audit.js";
import { describeRetention, formatBytes, pruneLogs, scanLogUnits, traceFiles } from "./log-retention.js";

/**
 * `ficta logs` — capture-log usage per group under the log root.
 * `ficta logs prune` — apply the retention policy now (ignoring the hourly throttle).
 * `ficta logs prune --traces` — also delete every raw-value trace file, whatever its age.
 * `ficta logs audit [--json]` — check captured bodies for protected values that reached the provider
 *   or a tool call; exits 1 when it finds a leak. Prints hashes and labels, never values.
 */
export async function runLogsCommand(args: readonly string[]): Promise<number> {
  const cfg = loadConfig();
  const [sub, ...flags] = args;
  if (sub === "prune") {
    const policy = flags.includes("--traces") ? { ...cfg.logRetention, traceMaxAgeMs: 0 } : cfg.logRetention;
    const result = await pruneLogs(cfg.logRoot, policy);
    process.stdout.write(
      `ficta logs: removed ${result.removedUnits} capture dir(s) and ${result.removedTraceFiles} raw trace file(s), freed ${formatBytes(result.freedBytes)}\n`,
    );
    return 0;
  }
  if (sub === "audit" && flags.every((flag) => flag === "--json")) {
    const report = await auditLogs(cfg.logRoot);
    process.stdout.write(flags.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatAuditReport(report));
    return auditLeakCount(report) > 0 ? 1 : 0;
  }
  if (sub !== undefined) {
    process.stderr.write("usage: ficta logs [prune [--traces] | audit [--json]]\n");
    return 2;
  }

  const units = await scanLogUnits(cfg.logRoot);
  const groups = new Map<string, { dirs: number; live: number; bytes: number; traces: number; traceBytes: number }>();
  for (const unit of units) {
    const group = groups.get(unit.group) ?? { dirs: 0, live: 0, bytes: 0, traces: 0, traceBytes: 0 };
    const traces = traceFiles(unit);
    group.dirs += 1;
    group.live += unit.live ? 1 : 0;
    group.bytes += unit.bytes;
    group.traces += traces.length;
    group.traceBytes += traces.reduce((sum, file) => sum + file.bytes, 0);
    groups.set(unit.group, group);
  }
  const total = [...groups.values()].reduce((sum, group) => sum + group.bytes, 0);
  const lines = [`ficta logs: ${cfg.logRoot} (${formatBytes(total)} in capture dirs)`];
  const width = Math.max(0, ...[...groups.keys()].map((name) => name.length));
  for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const traces = group.traces > 0 ? `, raw traces: ${group.traces} file(s) ${formatBytes(group.traceBytes)}` : "";
    lines.push(
      `  ${name.padEnd(width)}  ${group.dirs} dir(s) (${group.live} in use)  ${formatBytes(group.bytes)}${traces}`,
    );
  }
  if (groups.size === 0) lines.push("  (no capture dirs)");
  lines.push(`retention: ${describeRetention(cfg.logRetention)} — \`ficta logs prune\` applies it now`);
  if (cfg.devTrace) lines.push("! dev trace is ON: agent launches write raw request bodies and protected values here");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
