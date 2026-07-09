import type * as React from "react";
import { useEffect, useState } from "react";
import {
  fetchProtectionStats,
  fetchProtectionStatsHistory,
  type ProtectionStats,
  type ProtectionStatsDailySummary,
  type ProtectionStatsLabelBucket,
} from "@/lib/protection-stats";
import { cn } from "@/lib/utils";

export function RedactionProofSection() {
  const [proof, setProof] = useState<ProtectionStats>();
  const [history, setHistory] = useState<ProtectionStatsDailySummary[]>();

  useEffect(() => {
    let alive = true;
    fetchProtectionStats()
      .then((next) => {
        if (alive) setProof(next);
        return fetchProtectionStatsHistory().catch(() => []);
      })
      .then((nextHistory) => {
        if (alive) setHistory(nextHistory);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setProof({
          ok: false,
          proxyUrl: "",
          status: "bad_response",
          message: "Could not read ficta redaction proof.",
          detail: err instanceof Error ? err.message : String(err),
        });
        setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section aria-label="Redaction proof">
      <div className="pt-6 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Redaction proof</h3>
        <p className="pt-1 text-xs text-muted-foreground leading-relaxed">
          Running-session proof from the proxy. Counts and labels only; protected values are never shown.
        </p>
      </div>

      {proof === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading redaction proof...</p>
      ) : !proof.ok ? (
        <p className="py-4 text-sm text-muted-foreground">{proof.message}</p>
      ) : (
        <ProofRows proof={proof} history={history} />
      )}
    </section>
  );
}

function ProofRows({
  proof,
  history,
}: {
  proof: Extract<ProtectionStats, { ok: true }>;
  history: ProtectionStatsDailySummary[] | undefined;
}) {
  const { totals } = proof.stats;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 py-4 sm:grid-cols-3">
        <Metric label="Kept out" value={totals.keptOutOfModelValues} />
        <Metric label="Affected requests" value={totals.affectedRequests} />
        <Metric label="Restored" value={totals.restoredValues} />
        <Metric label="Survived" value={totals.survivingValues} warn={totals.survivingValues > 0} />
        <Metric label="Blocked" value={totals.blockedRequests} warn={totals.blockedRequests > 0} />
        <Metric
          label="Withheld from tool calls"
          value={totals.withheldFromToolsValues}
          warn={totals.withheldFromToolsValues > 0}
          description="Values the model placed in tool arguments that were replaced with placeholders this run."
        />
      </div>

      <TrendSummary history={history} />

      <div className="border-t border-border">
        {proof.stats.byLabel.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No redaction events have occurred in this proxy run yet.</p>
        ) : (
          <KeySummary buckets={proof.stats.byLabel} />
        )}
      </div>
    </>
  );
}

function TrendSummary({ history }: { history: ProtectionStatsDailySummary[] | undefined }) {
  const totals = history ? sumHistory(history) : undefined;
  const rows = history ?? [];
  const recent = rows.slice(-7).reverse();
  return (
    <div className="border-t border-border py-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">Last 90 days</h4>
          <p className="pt-1 text-muted-foreground text-xs leading-relaxed">
            Aggregated daily trend data only; this is not a request-level audit history.
          </p>
        </div>
        <Meta>UTC days</Meta>
      </div>

      {totals === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading trend summary...</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No retained redaction trend data yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 py-4 sm:grid-cols-5">
            <Metric label="Kept out" value={totals.keptOutOfModelValues} />
            <Metric label="Affected requests" value={totals.affectedRequests} />
            <Metric label="Restored" value={totals.restoredValues} />
            <Metric label="Survived" value={totals.survivingValues} warn={totals.survivingValues > 0} />
            <Metric label="Blocked" value={totals.blockedRequests} warn={totals.blockedRequests > 0} />
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-border bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Day
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Kept out
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Requests
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Survived
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Blocked
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((day) => (
                  <tr key={day.day} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs">{day.day}</td>
                    <CountCell value={day.keptOutOfModelValues} />
                    <CountCell value={day.affectedRequests} />
                    <CountCell value={day.survivingValues} warn={day.survivingValues > 0} />
                    <CountCell value={day.blockedRequests} warn={day.blockedRequests > 0} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  warn,
  description,
}: {
  label: string;
  value: number;
  warn?: boolean;
  description?: string;
}) {
  return (
    <div className="min-w-0 border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("pt-0.5 text-lg font-semibold", warn && "text-amber-700 dark:text-amber-300")}>{value}</div>
      {description ? <div className="pt-1 text-muted-foreground text-xs leading-snug">{description}</div> : null}
    </div>
  );
}

function KeySummary({ buckets }: { buckets: ProtectionStatsLabelBucket[] }) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">Protected keys and labels</h4>
          <p className="pt-1 text-muted-foreground text-xs leading-relaxed">
            Aggregated across this proxy run; individual request bodies are not listed.
          </p>
        </div>
        <Meta>{buckets.length} total</Meta>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-border bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Key or label
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Kept out
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Redacted
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Survived
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Requests
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Blocked
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucketKey(bucket)} className="border-b border-border last:border-b-0">
                <td className="min-w-0 px-3 py-2 align-top">
                  <div className="break-all font-mono text-xs text-foreground">{bucket.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge>{bucket.source}</Badge>
                    {bucket.kind ? <Badge>{bucket.kind}</Badge> : null}
                    {bucket.confidence ? <Badge>{bucket.confidence}</Badge> : null}
                  </div>
                </td>
                <CountCell value={bucket.keptOutOfModelValues} />
                <CountCell value={bucket.redactedValues} />
                <CountCell value={bucket.survivingValues} warn={bucket.survivingValues > 0} />
                <CountCell value={bucket.requests} />
                <CountCell value={bucket.blockedRequests} warn={bucket.blockedRequests > 0} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountCell({ value, warn }: { value: number; warn?: boolean }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2 align-top tabular-nums",
        warn && "font-medium text-amber-700 dark:text-amber-300",
      )}
    >
      {formatNumber(value)}
    </td>
  );
}

function bucketKey(bucket: ProtectionStatsLabelBucket): string {
  return [bucket.name, bucket.source, bucket.plugin ?? "", bucket.kind ?? "", bucket.confidence ?? ""].join("\0");
}

function sumHistory(history: ProtectionStatsDailySummary[]) {
  return history.reduce(
    (total, day) => ({
      events: total.events + day.events,
      affectedRequests: total.affectedRequests + day.affectedRequests,
      redactedValues: total.redactedValues + day.redactedValues,
      survivingValues: total.survivingValues + day.survivingValues,
      blockedRequests: total.blockedRequests + day.blockedRequests,
      keptOutOfModelValues: total.keptOutOfModelValues + day.keptOutOfModelValues,
      restoredValues: total.restoredValues + day.restoredValues,
      withheldFromToolsValues: total.withheldFromToolsValues + day.withheldFromToolsValues,
    }),
    {
      events: 0,
      affectedRequests: 0,
      redactedValues: 0,
      survivingValues: 0,
      blockedRequests: 0,
      keptOutOfModelValues: 0,
      restoredValues: 0,
      withheldFromToolsValues: 0,
    },
  );
}

// One shared formatter — Intl.NumberFormat is relatively heavy to construct, and CountCell renders
// many numeric cells per bucket row on every stats refresh.
const numberFormatter = new Intl.NumberFormat();

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2 text-xs font-medium",
        tone === "danger"
          ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100"
          : "border-border bg-secondary text-secondary-foreground",
      )}
    >
      {children}
    </span>
  );
}
