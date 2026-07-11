import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { AlertTriangle, ArrowLeft, Check, Loader2, Plus, ShieldCheck, Sparkles, X } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GatewayProtectionPreview } from "@/lib/protection-preview";
import {
  type PendingProtectionError,
  PROTECTION_REVIEW_BATCH_MAX,
  pendingProtectionRanges,
  validatePendingProtection,
} from "@/lib/protection-review-queue";
import { cn } from "@/lib/utils";

type ReviewMode = "values" | "model";

export function ProtectionReview({
  text,
  preview,
  busy,
  error,
  notice,
  onBack,
  onProtect,
  onRemove,
  onSend,
  onSuggest,
  suggestValues,
}: {
  text: string;
  preview: GatewayProtectionPreview;
  busy: boolean;
  error?: string;
  notice?: string;
  onBack: () => void;
  onProtect: (values: string[]) => Promise<void>;
  onRemove: (value: string) => Promise<void>;
  onSend: () => void;
  onSuggest: (values: string[]) => void;
  /** Values added during this review, excluding older chat protections already in force. */
  suggestValues: string[];
}) {
  const [mode, setMode] = useState<ReviewMode>("values");
  const [draftValue, setDraftValue] = useState("");
  const [pendingValues, setPendingValues] = useState<string[]>([]);
  const [pendingError, setPendingError] = useState<PendingProtectionError>();
  const pendingHelpError =
    pendingError ?? (pendingValues.length >= PROTECTION_REVIEW_BATCH_MAX ? ("limit" as const) : undefined);
  const counts = useMemo(() => findingCounts(preview.findings), [preview.findings]);
  const confirmedValues = useMemo(
    () => [
      ...new Set([
        ...preview.protectedValues,
        ...preview.findings.map((finding) => text.slice(finding.start, finding.end)),
      ]),
    ],
    [preview.findings, preview.protectedValues, text],
  );

  const queueValue = (rawValue: string) => {
    const result = validatePendingProtection({
      value: rawValue,
      originalText: text,
      pendingValues,
      protectedValues: confirmedValues,
    });
    if (!result.ok) {
      setPendingError(result.reason);
      return false;
    }
    setPendingValues((current) => [...current, result.value]);
    setPendingError(undefined);
    setDraftValue("");
    return true;
  };

  const captureSelection = (root: HTMLElement) => {
    const selected = window.getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    queueValue(range.toString());
    selected.removeAllRanges();
  };

  const addDraftValue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    queueValue(draftValue);
  };

  const applyPendingValues = async () => {
    if (pendingValues.length === 0 || busy) return;
    try {
      await onProtect(pendingValues);
      setPendingValues([]);
      setPendingError(undefined);
    } catch {
      // ChatView owns the request error copy. Keep this batch intact so the user can retry it.
    }
  };

  return (
    <section
      className="border-t border-border bg-background"
      aria-labelledby="protection-review-title"
      aria-busy={busy}
    >
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <h2 id="protection-review-title" className="font-semibold text-sm">
                  Review protection
                </h2>
              </div>
              <p className="mt-1 text-muted-foreground text-xs">
                Nothing is sent to the model until you choose Send protected.
              </p>
            </div>
            <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Protection preview view">
              <ModeButton selected={mode === "values"} onClick={() => setMode("values")}>
                Values
              </ModeButton>
              <ModeButton selected={mode === "model"} stale={pendingValues.length > 0} onClick={() => setMode("model")}>
                Model will see
              </ModeButton>
            </div>
          </div>

          <div className="px-4 py-3">
            {mode === "values" ? (
              <>
                <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-2 border-0 p-0 text-xs">
                  <legend className="sr-only">Protection legend</legend>
                  <Legend label="Registry · Exact" count={counts.registry} className="border-emerald-600" />
                  <Legend
                    label="Detected PII · Best effort"
                    count={counts.detected}
                    className="border-emerald-600 border-dashed"
                  />
                  <Legend
                    label="You protected · Exact in this chat"
                    count={counts.user}
                    className="border-foreground"
                  />
                </fieldset>
                <p className="mb-3 text-muted-foreground text-xs">
                  All highlighted text will be replaced before sending. Solid lines are exact matches; dashed lines are
                  detector matches.
                </p>
                <article
                  className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 px-3 py-3 text-[0.95rem] leading-6 selection:bg-amber-200 selection:text-amber-950 dark:selection:bg-amber-800 dark:selection:text-amber-50"
                  aria-label="Message to review"
                  onMouseUp={(event) => captureSelection(event.currentTarget)}
                  onKeyUp={(event) => captureSelection(event.currentTarget)}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard selection capture in review text.
                  tabIndex={0}
                >
                  <HighlightedText text={text} findings={preview.findings} pendingValues={pendingValues} />
                </article>
              </>
            ) : (
              <>
                {pendingValues.length > 0 ? (
                  <div
                    className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 text-xs dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
                    role="status"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    Apply the pending values to refresh what the model will see.
                  </div>
                ) : null}
                <article
                  className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 px-3 py-3 text-[0.95rem] leading-6 selection:bg-amber-200 selection:text-amber-950 dark:selection:bg-amber-800 dark:selection:text-amber-50"
                  aria-label="Text the model will see"
                  onMouseUp={(event) => captureSelection(event.currentTarget)}
                  onKeyUp={(event) => captureSelection(event.currentTarget)}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard selection capture in review text.
                  tabIndex={0}
                >
                  <ModelText text={preview.redactedText} />
                </article>
              </>
            )}

            {pendingValues.length > 0 ? (
              <section
                className="mt-3 rounded-lg border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/20"
                aria-labelledby="pending-protections-title"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p id="pending-protections-title" className="font-medium text-xs">
                    Ready to protect <span className="font-normal tabular-nums">{pendingValues.length}</span>
                  </p>
                  <Button type="button" size="sm" onClick={() => void applyPendingValues()} disabled={busy}>
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <ShieldCheck className="size-4" aria-hidden />
                    )}
                    Protect {pendingValues.length} {pendingValues.length === 1 ? "value" : "values"}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pendingValues.map((value) => (
                    <span
                      key={value}
                      className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-amber-400 bg-background py-0.5 pr-1 pl-2.5 text-xs dark:border-amber-700"
                      title={value}
                    >
                      <span className="max-w-56 truncate">{value}</span>
                      <button
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-amber-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-amber-900/40"
                        onClick={() => {
                          setPendingValues((current) => current.filter((entry) => entry !== value));
                          setPendingError(undefined);
                        }}
                        disabled={busy}
                        aria-label={`Remove ${value} from values ready to protect`}
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            <form className="mt-3 flex min-h-9 flex-wrap items-center gap-2" onSubmit={addDraftValue}>
              <label htmlFor="protect-missed-phrase" className="sr-only">
                Phrase to add to protection batch
              </label>
              <Input
                id="protect-missed-phrase"
                value={draftValue}
                className="min-w-48 flex-1"
                placeholder="Type a phrase to protect"
                onChange={(event) => {
                  setDraftValue(event.target.value);
                  setPendingError(undefined);
                }}
                aria-describedby="protected-selection-help"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={busy || !draftValue.trim()}>
                <Plus className="size-4" aria-hidden />
                Add
              </Button>
            </form>
            <p
              id="protected-selection-help"
              className={cn("mt-1.5 text-xs", pendingHelpError ? "text-destructive" : "text-muted-foreground")}
              role={pendingHelpError ? "alert" : undefined}
            >
              {pendingHelpError
                ? pendingProtectionErrorMessage(pendingHelpError)
                : "Highlight text above, or type a phrase to add it."}
            </p>

            {preview.protectedValues.length > 0 ? (
              <section className="mt-3" aria-labelledby="chat-protections-title">
                <p id="chat-protections-title" className="mb-1.5 font-medium text-xs">
                  Protected in this chat
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {preview.protectedValues.map((value) => (
                    <span
                      key={value}
                      className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pr-1 pl-2.5 text-xs"
                      title={value}
                    >
                      <span className="max-w-56 truncate">{value}</span>
                      <button
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void onRemove(value)}
                        disabled={busy}
                        aria-label={`Stop protecting ${value} in this chat`}
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            {error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="mt-3 text-emerald-800 text-sm dark:text-emerald-200" role="status">
                {notice}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={busy}>
                <ArrowLeft className="size-4" aria-hidden />
                Back to edit
              </Button>
              {suggestValues.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSuggest(suggestValues)}
                  disabled={busy}
                >
                  <Sparkles className="size-4" aria-hidden />
                  Suggest for workspace
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1">
              <Button
                type="button"
                size="sm"
                onClick={onSend}
                disabled={busy || pendingValues.length > 0}
                aria-describedby={pendingValues.length > 0 ? "pending-send-help" : undefined}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-4" aria-hidden />
                )}
                Send protected
              </Button>
              {pendingValues.length > 0 ? (
                <p id="pending-send-help" className="text-amber-800 text-xs dark:text-amber-200">
                  Apply the pending values before sending.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModeButton({
  selected,
  stale = false,
  onClick,
  children,
}: {
  selected: boolean;
  stale?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        "min-h-8 rounded-md px-2.5 font-medium text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
      {stale ? (
        <>
          <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-500" aria-hidden />
          <span className="sr-only"> — refresh needed</span>
        </>
      ) : null}
    </button>
  );
}

function Legend({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        className={cn("size-3 rounded-[3px] border-2 bg-emerald-50 dark:bg-emerald-950/40", className)}
        aria-hidden
      />
      {label} <span className="tabular-nums">{count}</span>
    </span>
  );
}

function HighlightedText({
  text,
  findings,
  pendingValues,
}: {
  text: string;
  findings: ProtectionPreviewFinding[];
  pendingValues: string[];
}) {
  const pendingRanges = pendingProtectionRanges(text, pendingValues, findings);
  if (findings.length === 0 && pendingRanges.length === 0) return text;
  const ranges = [
    ...findings.map((finding) => ({ ...finding, kind: "confirmed" as const })),
    ...pendingRanges.map((range) => ({ ...range, kind: "pending" as const })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start < cursor || range.end > text.length) return;
    parts.push(text.slice(cursor, range.start));
    if (range.kind === "pending") {
      parts.push(
        <mark
          key={`${range.start}:${range.end}:pending`}
          className="rounded-[3px] border-amber-500 border-b-2 bg-amber-100 px-0.5 text-foreground dark:bg-amber-950/60"
          title="Ready to protect"
        >
          {text.slice(range.start, range.end)}
        </mark>,
      );
      cursor = range.end;
      return;
    }
    parts.push(
      <mark
        key={`${range.start}:${range.end}:${range.origin}`}
        className={cn(
          "rounded-[3px] border-b-2 bg-emerald-100 px-0.5 text-foreground dark:bg-emerald-950/60",
          range.origin === "registry" && "border-emerald-600",
          range.origin === "detected" && "border-emerald-600 border-dashed",
          range.origin === "user" && "border-foreground",
        )}
        title={
          range.origin === "user"
            ? "Protected by you"
            : range.origin === "registry"
              ? "Protected Registry"
              : "Detected PII"
        }
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  parts.push(text.slice(cursor));
  return parts;
}

function ModelText({ text }: { text: string }) {
  const token = /FICTA_(?:[A-Z0-9]{1,12}_)?[0-9a-f]{32}/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const start = match.index;
    parts.push(text.slice(cursor, start));
    parts.push(
      <code
        key={`${start}:${match[0]}`}
        className="rounded bg-background px-1 py-0.5 font-mono text-[0.82em]"
        title="Already protected"
      >
        {match[0]}
      </code>,
    );
    cursor = start + match[0].length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function pendingProtectionErrorMessage(error: PendingProtectionError): string {
  switch (error) {
    case "empty":
      return "Select or type a phrase first.";
    case "duplicate":
      return "That phrase is already ready to protect.";
    case "protected":
      return "That phrase is already protected.";
    case "surrogate":
      return "FICTA tokens are already protected. Select ordinary text instead.";
    case "absent":
      return "That phrase does not appear in the original message.";
    case "limit":
      return `Apply these ${PROTECTION_REVIEW_BATCH_MAX} values before adding more.`;
  }
}

export function ProtectionReviewLoading({ onBack }: { onBack: () => void }) {
  return (
    <section className="border-t border-border bg-background" aria-label="Reviewing protection" aria-busy="true">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="rounded-2xl border border-border bg-card px-4 py-5 shadow-sm">
          <div className="flex items-center gap-3">
            <Loader2 className="size-4 animate-spin text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div>
              <h2 className="font-semibold text-sm">Reviewing protection</h2>
              <p className="mt-1 text-muted-foreground text-xs">Checking the registry and enabled PII detectors…</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-4" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden />
            Back to edit
          </Button>
        </div>
      </div>
    </section>
  );
}

function findingCounts(findings: ProtectionPreviewFinding[]) {
  const counts = { registry: 0, detected: 0, user: 0 };
  for (const finding of findings) counts[finding.origin]++;
  return counts;
}
