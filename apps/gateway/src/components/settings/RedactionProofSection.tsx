import type * as React from "react";
import { useEffect, useState } from "react";
import { fetchProtectionStats, type ProtectionHit, type ProtectionStats } from "@/lib/protection-stats";
import { cn } from "@/lib/utils";

export function RedactionProofSection() {
  const [proof, setProof] = useState<ProtectionStats>();

  useEffect(() => {
    let alive = true;
    fetchProtectionStats()
      .then((next) => {
        if (alive) setProof(next);
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
        <ProofRows proof={proof} />
      )}
    </section>
  );
}

function ProofRows({ proof }: { proof: Extract<ProtectionStats, { ok: true }> }) {
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
          label="Withheld from tools"
          value={totals.withheldFromToolsValues}
          warn={totals.withheldFromToolsValues > 0}
        />
      </div>

      <div className="border-t border-border">
        {proof.stats.events.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No redaction events have occurred in this proxy run yet.</p>
        ) : (
          proof.stats.events.map((event) => (
            <div key={event.index} className="border-b border-border py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{event.model}</span>
                <Meta>{event.surface}</Meta>
                <Meta>#{event.requestId ?? event.index}</Meta>
                <Meta>{formatTime(event.at)}</Meta>
                {event.blocked ? <Badge tone="danger">Blocked</Badge> : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{event.redactedValues} redacted</span>
                <span className={event.survivingValues > 0 ? "font-medium text-amber-700 dark:text-amber-300" : ""}>
                  {event.survivingValues} survived
                </span>
                <span>{event.method}</span>
                <span className="break-all font-mono">{event.path}</span>
              </div>
              <HitList hits={[...event.redactedHits, ...event.survivingHits]} />
            </div>
          ))
        )}
      </div>
    </>
  );
}

function Metric({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="min-w-0 border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("pt-0.5 text-lg font-semibold", warn && "text-amber-700 dark:text-amber-300")}>{value}</div>
    </div>
  );
}

function HitList({ hits }: { hits: ProtectionHit[] }) {
  const labels = uniqueHits(hits);
  if (labels.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {labels.map((hit) => (
        <Badge key={hit}>{hit}</Badge>
      ))}
    </div>
  );
}

function uniqueHits(hits: ProtectionHit[]): string[] {
  const labels = hits.map(hitLabel);
  return [...new Set(labels)].slice(0, 6);
}

function hitLabel(hit: ProtectionHit): string {
  const detail = [hit.kind, hit.confidence].filter(Boolean).join(" / ");
  return detail ? `${hit.name} / ${hit.source} / ${detail}` : `${hit.name} / ${hit.source}`;
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
