import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchThreadEgressReceipt } from "@/lib/storage/threads";
import type { ThreadEgressReceipt } from "@/lib/storage/types";

export function ThreadEvidenceDialog({
  open,
  onOpenChange,
  threadId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
}) {
  const [receipt, setReceipt] = useState<ThreadEgressReceipt>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setReceipt(undefined);
    setError(undefined);
    fetchThreadEgressReceipt({ data: { threadId } })
      .then((next) => alive && setReceipt(next))
      .catch(() => alive && setError("Could not load this thread's egress evidence."));
    return () => {
      alive = false;
    };
  }, [open, threadId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Thread egress evidence</DialogTitle>
          <DialogDescription>
            Values-free evidence for requests sent through this chat. It proves registered or detected values only;
            undetected sensitive content is outside this record.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : receipt === undefined ? (
          <p className="text-sm text-muted-foreground">Loading evidence…</p>
        ) : (
          <Receipt receipt={receipt} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Receipt({ receipt }: { receipt: ThreadEgressReceipt }) {
  if (receipt.events.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No provider-bound requests have been recorded for this thread yet.
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Forwarded" value={receipt.forwardedRequests} />
        <Metric label="Blocked" value={receipt.blockedRequests} />
        <Metric label="Values tokenized" value={receipt.tokenizedValues} />
        <Metric label="Known values left" value={receipt.survivingValues} warn={receipt.survivingValues > 0} />
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-border">
        {receipt.events.map((event) => (
          <div key={event.eventId} className="border-b border-border px-3 py-2.5 last:border-b-0">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">
                {event.outcome === "forwarded"
                  ? "Forwarded after screening"
                  : event.outcome === "blocked"
                    ? "Blocked before egress"
                    : "Provider request failed"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{new Date(event.at).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {event.model} · {event.screening.replaceAll("_", " ")} · {event.redactedValues} values tokenized ·{" "}
              {event.survivingValues} known values left
            </p>
            {event.labels.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">Labels: {formatLabelCounts(event.labels)}</p>
            ) : null}
          </div>
        ))}
      </div>
      {receipt.chainRoot ? (
        <p className="break-all font-mono text-xs text-muted-foreground">Chain root: {receipt.chainRoot}</p>
      ) : null}
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => downloadReceipt(receipt)}>
          Download receipt
        </Button>
      </div>
    </div>
  );
}

function formatLabelCounts(labels: ThreadEgressReceipt["events"][number]["labels"]): string {
  return [...labels]
    .sort(
      (a, b) =>
        (b.redactedValues ?? 0) - (a.redactedValues ?? 0) ||
        (b.survivingValues ?? 0) - (a.survivingValues ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .map((label) => {
      const protectedCount = label.redactedValues;
      const survived = label.survivingValues ?? 0;
      if (protectedCount === undefined) return label.name; // Receipt created before per-label counts.
      return `${label.name} × ${protectedCount}${survived > 0 ? ` (${survived} left)` : ""}`;
    })
    .join(", ");
}

function downloadReceipt(receipt: ThreadEgressReceipt): void {
  const blob = new Blob(
    [
      JSON.stringify(
        { schema: "ficta.thread-egress-receipt.v1", generatedAt: new Date().toISOString(), receipt },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ficta-thread-egress-receipt-${receipt.threadId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Metric({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={warn ? "border border-amber-400 px-3 py-2" : "border border-border px-3 py-2"}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          warn ? "pt-0.5 text-lg font-semibold text-amber-700 dark:text-amber-300" : "pt-0.5 text-lg font-semibold"
        }
      >
        {value}
      </div>
    </div>
  );
}
