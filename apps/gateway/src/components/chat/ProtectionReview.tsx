import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { ArrowLeft, Check, Copy, Loader2, Plus, ShieldCheck, Sparkles, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GatewayProtectionPreview } from "@/lib/protection-preview";
import {
  automaticProtectionValues,
  normalizeHighlightedProtectionValue,
  type ProtectionSelectionCandidate,
  type ProtectionValueError,
  protectionSelectionCandidate,
  validateProtectionValue,
} from "@/lib/protection-review-value";
import {
  previewFindingsToAnnotations,
  type ProtectionHighlightAnnotation,
  protectionTextSegments,
} from "@/lib/restore-highlights";
import { flaggedLineCount, type SecondOpinion, secondOpinionKindLabel } from "@/lib/second-opinion";
import { cn } from "@/lib/utils";
import { ProtectionMark } from "./ProtectionMark";

type ReviewMode = "values" | "model";

export const PROTECTION_REVIEW_SCOPE_COPY =
  "Automatic protection covers identity and attribution, not every confidential business term.";
export const PROTECTION_REVIEW_SECOND_OPINION_COPY =
  "A second opinion flagged lines that may still name a party or state a commercial term. Select the exact value to protect it; nothing is protected automatically.";
export const PROTECTION_REVIEW_SECOND_OPINION_LEGEND = "Second opinion · check this line";
export const PROTECTION_REVIEW_SECOND_OPINION_LINE_TITLE =
  "Second opinion: this line may name a party or state a commercial term that is not protected.";
export const PROTECTION_REVIEW_ADD_COPY =
  "Highlight text above to copy or protect it, or type an amount, project name, code, or clause below.";
export const PROTECTION_REVIEW_SUGGESTION_COPY =
  "Workspace proposals send the normalized protected phrase to admins. It is not workspace-wide until approved and published.";
export const MODEL_SURROGATE_TOKEN_PATTERN =
  /(?<![0-9A-Za-z_])FICTA_(?:[0-9a-f]{32}|[A-Z0-9]{1,12}_[0-9a-f]{32}|(?:ORG|PERSON)_[A-Z2-7]{12}_[A-Z2-7]{12})(?![0-9A-Za-z_])/g;

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
  modelSummary,
}: {
  text: string;
  preview: GatewayProtectionPreview;
  busy: boolean;
  error?: string;
  notice?: string;
  onBack: () => void;
  onProtect: (value: string, destination: "chat" | "chat-and-workspace") => Promise<void>;
  onRemove: (value: string) => Promise<void>;
  onSend: () => void;
  onSuggest: (values: string[]) => void;
  /** Values added during this review, excluding older chat protections already in force. */
  suggestValues: string[];
  /** Read-only context for the request this preview will send. */
  modelSummary: string;
}) {
  const [mode, setMode] = useState<ReviewMode>("values");
  const [draftValue, setDraftValue] = useState("");
  const [valueError, setValueError] = useState<ProtectionValueError>();
  const [selection, setSelection] = useState<ProtectionSelectionCandidate>();
  const [copyStatus, setCopyStatus] = useState<"idle" | "error">("idle");
  const counts = useMemo(() => findingCounts(preview.findings), [preview.findings]);
  const findingTotal = counts.registry + counts.detected + counts.user;
  const flaggedLines = flaggedLineCount(preview.secondOpinion);
  const automaticValues = useMemo(() => automaticProtectionValues(text, preview.findings), [preview.findings, text]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const action = protectionReviewShortcut(event, busy);
      if (!action) return;
      event.preventDefault();
      if (action === "back") {
        onBack();
        return;
      }
      onSend();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [busy, onBack, onSend]);

  const protectValue = async (
    rawValue: string,
    source: "selection" | "typed",
    destination: "chat" | "chat-and-workspace" = "chat",
  ) => {
    if (busy) return false;
    const value = source === "selection" ? normalizeHighlightedProtectionValue(rawValue) : rawValue;
    const result = validateProtectionValue({
      value,
      originalText: text,
      protectedValues: preview.protectedValues,
      ...automaticValues,
    });
    if (!result.ok) {
      setValueError(result.reason);
      return false;
    }
    try {
      await onProtect(result.value, destination);
      setValueError(undefined);
      if (source === "selection") {
        setSelection(undefined);
        setCopyStatus("idle");
        window.getSelection()?.removeAllRanges();
      }
      return true;
    } catch {
      // ChatView owns the request error copy. Leave typed input intact so the user can retry it.
      return false;
    }
  };

  const captureSelection = (root: HTMLElement) => {
    if (busy) return;
    const selected = window.getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed) {
      setSelection(undefined);
      setCopyStatus("idle");
      return;
    }
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    setSelection(
      protectionSelectionCandidate({
        rawValue: range.toString(),
        originalText: text,
        protectedValues: preview.protectedValues,
        ...automaticValues,
      }),
    );
    setCopyStatus("idle");
    setValueError(undefined);
  };

  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.rawValue);
      // A copied selection no longer needs its action panel. Keep the wider review open so people can
      // inspect or protect other values before sending.
      setSelection(undefined);
      setCopyStatus("idle");
      window.getSelection()?.removeAllRanges();
    } catch {
      setCopyStatus("error");
    }
  };

  const changeMode = (nextMode: ReviewMode) => {
    setMode(nextMode);
    setSelection(undefined);
    setCopyStatus("idle");
    window.getSelection()?.removeAllRanges();
  };

  const addDraftValue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await protectValue(draftValue, "typed")) setDraftValue("");
  };

  return (
    <section className="min-w-0" aria-labelledby="protection-review-title" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-4">
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
          <p className="mt-1 max-w-[65ch] text-muted-foreground text-xs">{PROTECTION_REVIEW_SCOPE_COPY}</p>
          <p className="mt-1 truncate text-muted-foreground text-xs">{modelSummary}</p>
        </div>
        <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Protection preview view">
          <ModeButton
            selected={mode === "values"}
            controls="protection-values-panel"
            onClick={() => changeMode("values")}
          >
            Values
          </ModeButton>
          <ModeButton selected={mode === "model"} controls="protection-model-panel" onClick={() => changeMode("model")}>
            Model will see
          </ModeButton>
        </div>
      </div>

      <div className="px-3 py-3 sm:px-4">
        {mode === "values" ? (
          <div id="protection-values-panel" role="tabpanel">
            {findingTotal > 0 || flaggedLines > 0 ? (
              <>
                <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-2 border-0 p-0 text-xs">
                  <legend className="sr-only">Protection legend</legend>
                  {findingTotal > 0 ? (
                    <>
                      <Legend label="Registry · Exact" count={counts.registry} className="border-emerald-600" />
                      <Legend
                        label="Detected identity · best effort"
                        count={counts.detected}
                        className="border-emerald-600 border-dashed"
                      />
                      <Legend
                        label="You protected · Exact in this chat"
                        count={counts.user}
                        className="border-foreground"
                      />
                    </>
                  ) : null}
                  {flaggedLines > 0 ? (
                    <Legend
                      label={PROTECTION_REVIEW_SECOND_OPINION_LEGEND}
                      count={flaggedLines}
                      className="border-sky-200 bg-sky-100 dark:border-sky-900 dark:bg-sky-950/50"
                    />
                  ) : null}
                </fieldset>
                {findingTotal > 0 ? (
                  <p className="mb-3 text-muted-foreground text-xs">
                    All highlighted text will be replaced before sending. Solid lines are exact matches; dashed lines
                    are detector matches.
                  </p>
                ) : null}
                {flaggedLines > 0 ? (
                  <p className="mb-3 text-muted-foreground text-xs" role="status">
                    {PROTECTION_REVIEW_SECOND_OPINION_COPY}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mb-3 text-muted-foreground text-xs" role="status">
                No protected values were found in this message. You can send it as written or add a phrase below.
              </p>
            )}
            <article
              className="max-h-[min(18rem,40dvh)] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 px-3 py-3 text-[0.95rem] leading-6 selection:bg-amber-200 selection:text-amber-950 dark:selection:bg-amber-800 dark:selection:text-amber-50"
              aria-label="Message to review"
              onMouseUp={(event) => captureSelection(event.currentTarget)}
              onKeyUp={(event) => captureSelection(event.currentTarget)}
              // Focus enables keyboard selection capture in review text.
              tabIndex={0}
            >
              <HighlightedText text={text} findings={preview.findings} secondOpinion={preview.secondOpinion} />
            </article>
          </div>
        ) : (
          <article
            id="protection-model-panel"
            role="tabpanel"
            className="max-h-[min(20rem,45dvh)] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 px-3 py-3 text-[0.95rem] leading-6 selection:bg-amber-200 selection:text-amber-950 dark:selection:bg-amber-800 dark:selection:text-amber-50"
            aria-label="Text the model will see"
            onMouseUp={(event) => captureSelection(event.currentTarget)}
            onKeyUp={(event) => captureSelection(event.currentTarget)}
            // Focus enables keyboard selection capture in review text.
            tabIndex={0}
          >
            <ModelText text={preview.redactedText} />
          </article>
        )}

        {selection ? (
          <section
            className="mt-2 rounded-lg border border-border bg-muted/35 p-2.5"
            aria-label="Selected text actions"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs">
                <span className="font-medium">Selected:</span>{" "}
                <span className="text-muted-foreground" title={selection.rawValue}>
                  “{selectionPreview(selection.rawValue)}”
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="button" variant="ghost" size="sm" onClick={copySelection}>
                  <Copy className="size-4" aria-hidden />
                  Copy
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void protectValue(selection.rawValue, "selection")}
                  disabled={busy || !selection.protection.ok}
                  aria-describedby="selected-text-action-help"
                >
                  <ShieldCheck className="size-4" aria-hidden />
                  Protect in chat
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void protectValue(selection.rawValue, "selection", "chat-and-workspace")}
                  disabled={busy || !selection.protection.ok}
                  aria-describedby="selected-text-action-help"
                  aria-label="Protect in chat and propose to workspace"
                >
                  <Sparkles className="size-4" aria-hidden />
                  Protect + propose
                </Button>
              </div>
            </div>
            <p
              id="selected-text-action-help"
              className={cn("mt-1.5 text-xs", copyStatus === "error" ? "text-destructive" : "text-muted-foreground")}
              role={copyStatus === "error" ? "alert" : undefined}
            >
              {copyStatus === "error"
                ? "Couldn’t copy automatically. The text is still selected; press Ctrl/⌘ C to copy it."
                : selection.protection.ok
                  ? PROTECTION_REVIEW_SUGGESTION_COPY
                  : protectionValueErrorMessage(selection.protection.reason)}
            </p>
          </section>
        ) : null}

        <form className="mt-3 flex min-h-9 flex-wrap items-center gap-2" onSubmit={addDraftValue}>
          <label htmlFor="protect-missed-phrase" className="sr-only">
            Phrase to protect in this chat
          </label>
          <Input
            id="protect-missed-phrase"
            value={draftValue}
            className="min-w-48 flex-1"
            placeholder="Type a phrase to protect"
            onChange={(event) => {
              setDraftValue(event.target.value);
              setValueError(undefined);
            }}
            aria-describedby="protected-selection-help"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !draftValue.trim()}>
            <Plus className="size-4" aria-hidden />
            Protect phrase
          </Button>
        </form>
        <p
          id="protected-selection-help"
          className={cn("mt-1.5 text-xs", valueError ? "text-destructive" : "text-muted-foreground")}
          role={valueError ? "alert" : undefined}
        >
          {valueError ? protectionValueErrorMessage(valueError) : PROTECTION_REVIEW_ADD_COPY}
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
                    onClick={() => {
                      setValueError(undefined);
                      void onRemove(value);
                    }}
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
            <Button type="button" variant="ghost" size="sm" onClick={() => onSuggest(suggestValues)} disabled={busy}>
              <Sparkles className="size-4" aria-hidden />
              Suggest for workspace
            </Button>
          ) : null}
        </div>
        <div>
          <Button type="button" variant="protection" size="sm" onClick={onSend} disabled={busy} autoFocus>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
            Send protected
            <span className="hidden text-xs opacity-70 sm:inline">Ctrl/⌘ Enter</span>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function protectionReviewShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "defaultPrevented">,
  busy: boolean,
): "back" | "send" | undefined {
  if (event.defaultPrevented || busy) return undefined;
  if (event.key === "Escape") return "back";
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return "send";
  return undefined;
}

function ModeButton({
  selected,
  controls,
  onClick,
  children,
}: {
  selected: boolean;
  controls: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
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

function HighlightedText({
  text,
  findings,
  secondOpinion,
}: {
  text: string;
  findings: ProtectionPreviewFinding[];
  secondOpinion?: SecondOpinion;
}) {
  const annotations = previewFindingsToAnnotations(text, findings);
  const notes = secondOpinionNotes(findings, secondOpinion);
  const flagged = secondOpinion?.status === "ok" ? [...secondOpinion.lines].sort((a, b) => a.start - b.start) : [];
  if (flagged.length === 0) return highlightedSegments(text, annotations, notes, "");

  // Flagged lines are wrapped so the user sees where to look. Authoritative highlights are clipped to
  // each chunk; a finding that crosses a chunk boundary renders as two marks over the same value.
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const line of flagged) {
    if (line.end < cursor) continue;
    const start = Math.max(line.start, cursor);
    if (start > cursor) nodes.push(...highlightedChunk(text, annotations, notes, cursor, start));
    nodes.push(
      <span
        key={`flag:${line.line}`}
        className="box-decoration-clone rounded-[3px] bg-sky-100/80 px-0.5 dark:bg-sky-950/50"
        title={PROTECTION_REVIEW_SECOND_OPINION_LINE_TITLE}
        data-second-opinion="line"
      >
        {highlightedChunk(text, annotations, notes, start, line.end)}
      </span>,
    );
    cursor = line.end;
  }
  if (cursor < text.length) nodes.push(...highlightedChunk(text, annotations, notes, cursor, text.length));
  return nodes;
}

function highlightedChunk(
  text: string,
  annotations: readonly ProtectionHighlightAnnotation[],
  notes: ReadonlyMap<string, string>,
  from: number,
  to: number,
): ReactNode[] {
  const clipped = annotations
    .filter((annotation) => annotation.start < to && annotation.end > from)
    .map((annotation) => ({
      ...annotation,
      start: Math.max(annotation.start, from) - from,
      end: Math.min(annotation.end, to) - from,
    }));
  return highlightedSegments(text.slice(from, to), clipped, notes, `${from}:`);
}

function highlightedSegments(
  text: string,
  annotations: readonly ProtectionHighlightAnnotation[],
  notes: ReadonlyMap<string, string>,
  keyPrefix: string,
): ReactNode[] {
  return protectionTextSegments(text, annotations).map((segment, index) =>
    segment.annotation ? (
      <ProtectionMark
        key={`${keyPrefix}${segment.annotation.start}:${segment.annotation.end}:${segment.annotation.origin}`}
        direction="redacted"
        origin={segment.annotation.origin}
        note={segment.annotation.origin === "detected" ? notes.get(segment.annotation.surrogate) : undefined}
      >
        {segment.text}
      </ProtectionMark>
    ) : (
      // Plain segments are stable between authoritative findings.
      <span key={`${keyPrefix}${index}`}>{segment.text}</span>
    ),
  );
}

/** Advisory kind per detected surrogate. Keyed by surrogate so clipped marks still find their note. */
function secondOpinionNotes(
  findings: readonly ProtectionPreviewFinding[],
  secondOpinion: SecondOpinion | undefined,
): Map<string, string> {
  const notes = new Map<string, string>();
  if (secondOpinion?.status !== "ok") return notes;
  for (const label of secondOpinion.findings) {
    const finding = findings.find((item) => item.start === label.start && item.end === label.end);
    if (finding?.origin === "detected") notes.set(finding.surrogate, secondOpinionKindLabel(label.kind));
  }
  return notes;
}

function ModelText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SURROGATE_TOKEN_PATTERN)) {
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

function protectionValueErrorMessage(error: ProtectionValueError): string {
  switch (error) {
    case "empty":
      return "Select or type a phrase first.";
    case "protected-chat":
      return "That phrase is already protected in this chat.";
    case "protected-registry":
      return "That phrase is already protected by the workspace registry.";
    case "protected-detected":
      return "That phrase is already covered by automatic detection.";
    case "surrogate":
      return "FICTA tokens are already protected. Select ordinary text instead.";
    case "absent":
      return "That phrase does not appear in the original message.";
  }
}

function selectionPreview(value: string): string {
  const preview = value.replace(/\s+/gu, " ").trim();
  return preview.length > 96 ? `${preview.slice(0, 95)}…` : preview;
}

export function ProtectionReviewLoading({ onBack }: { onBack: () => void }) {
  return (
    <section className="px-3 py-4 sm:px-4" aria-label="Reviewing protection" aria-busy="true">
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
    </section>
  );
}

function findingCounts(findings: ProtectionPreviewFinding[]) {
  const counts = { registry: 0, detected: 0, user: 0 };
  for (const finding of findings) counts[finding.origin]++;
  return counts;
}
