import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { ArrowLeft, Check, Loader2, ShieldCheck, Sparkles, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GatewayProtectionPreview } from "@/lib/protection-preview";
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
  onProtect: (value: string) => Promise<void>;
  onRemove: (value: string) => Promise<void>;
  onSend: () => void;
  onSuggest: (values: string[]) => void;
  /** Values added during this review, excluding older chat protections already in force. */
  suggestValues: string[];
}) {
  const [mode, setMode] = useState<ReviewMode>("values");
  const [selection, setSelection] = useState("");
  const counts = useMemo(() => findingCounts(preview.findings), [preview.findings]);
  const selectionAlreadyProtected = useMemo(
    () => isAlreadyProtectedSelection(selection, text, preview),
    [selection, text, preview],
  );
  const selectionNotInOriginal = Boolean(selection.trim()) && !text.includes(selection.trim());

  const captureSelection = (root: HTMLElement) => {
    const selected = window.getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed) {
      setSelection("");
      return;
    }
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setSelection("");
      return;
    }
    setSelection(range.toString().trim());
  };

  const protectSelection = async () => {
    const value = selection.trim();
    if (!value || selectionAlreadyProtected || selectionNotInOriginal) return;
    await onProtect(value);
    setSelection("");
    window.getSelection()?.removeAllRanges();
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
              <ModeButton selected={mode === "model"} onClick={() => setMode("model")}>
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
                >
                  <HighlightedText text={text} findings={preview.findings} />
                </article>
              </>
            ) : (
              <article
                className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 px-3 py-3 text-[0.95rem] leading-6 selection:bg-amber-200 selection:text-amber-950 dark:selection:bg-amber-800 dark:selection:text-amber-50"
                aria-label="Text the model will see"
                onMouseUp={(event) => captureSelection(event.currentTarget)}
              >
                <ModelText text={preview.redactedText} />
              </article>
            )}

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

            <div className="mt-3 flex min-h-9 flex-wrap items-center gap-2">
              <label htmlFor="protect-missed-phrase" className="sr-only">
                Missed phrase to protect
              </label>
              <Input
                id="protect-missed-phrase"
                value={selection}
                className="min-w-48 flex-1"
                placeholder={
                  mode === "model"
                    ? "Select unprotected model text or type a phrase"
                    : "Select above or type a missed phrase"
                }
                onChange={(event) => setSelection(event.target.value)}
                aria-describedby={
                  selectionAlreadyProtected || selectionNotInOriginal ? "protected-selection-help" : undefined
                }
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void protectSelection()}
                disabled={busy || !selection.trim() || selectionAlreadyProtected || selectionNotInOriginal}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="size-4" aria-hidden />
                )}
                Protect in this chat
              </Button>
            </div>
            {selectionAlreadyProtected ? (
              <p id="protected-selection-help" className="mt-1.5 text-muted-foreground text-xs" role="status">
                That selection is already protected. Select ordinary text that still appears in the model view.
              </p>
            ) : selectionNotInOriginal ? (
              <p id="protected-selection-help" className="mt-1.5 text-muted-foreground text-xs" role="status">
                Select one continuous unprotected phrase without including a FICTA token.
              </p>
            ) : (
              <p className="mt-1.5 text-muted-foreground text-xs">
                Add one phrase at a time; each protected value appears above and can be removed before sending.
              </p>
            )}

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
            <Button type="button" size="sm" onClick={onSend} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
              Send protected
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModeButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
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

function HighlightedText({ text, findings }: { text: string; findings: ProtectionPreviewFinding[] }) {
  if (findings.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  findings.forEach((finding) => {
    if (finding.start < cursor || finding.end > text.length) return;
    parts.push(text.slice(cursor, finding.start));
    parts.push(
      <mark
        key={`${finding.start}:${finding.end}:${finding.origin}`}
        className={cn(
          "rounded-[3px] border-b-2 bg-emerald-100 px-0.5 text-foreground dark:bg-emerald-950/60",
          finding.origin === "registry" && "border-emerald-600",
          finding.origin === "detected" && "border-emerald-600 border-dashed",
          finding.origin === "user" && "border-foreground",
        )}
        title={
          finding.origin === "user"
            ? "Protected by you"
            : finding.origin === "registry"
              ? "Protected Registry"
              : "Detected PII"
        }
      >
        {text.slice(finding.start, finding.end)}
      </mark>,
    );
    cursor = finding.end;
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

const SURROGATE_SELECTION = /FICTA_(?:[A-Z0-9]{1,12}_)?[0-9a-f]{32}/;

function isAlreadyProtectedSelection(
  selection: string,
  originalText: string,
  preview: GatewayProtectionPreview,
): boolean {
  const value = selection.trim();
  if (!value) return false;
  if (SURROGATE_SELECTION.test(value) || preview.protectedValues.includes(value)) return true;
  return preview.findings.some((finding) => originalText.slice(finding.start, finding.end) === value);
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
