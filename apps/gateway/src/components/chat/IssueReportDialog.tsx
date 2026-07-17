import { CircleAlert, CircleCheck, Info, Loader2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ISSUE_REPORT_DETAILS_MAX,
  type IssueReportResult,
  type ReportKind,
  submitIssueReport,
} from "@/lib/issue-reporting";

/** Collect and submit a report while preserving the draft across loading and failure states. */
export function IssueReportDialog({
  open,
  onOpenChange,
  reporterEmail,
  threadId,
  messageId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reporterEmail: string;
  threadId: string;
  messageId?: string;
}) {
  const detailsId = useId();
  const detailsHelpId = useId();
  const errorId = useId();
  const [kind, setKind] = useState<ReportKind>("bug");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<Extract<IssueReportResult, { ok: true }>>();

  const reset = () => {
    setKind("bug");
    setDetails("");
    setSubmitting(false);
    setError("");
    setSuccess(undefined);
  };

  const changeOpen = (next: boolean) => {
    if (!next && submitting) return;
    if (!next && success) reset();
    onOpenChange(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!details.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await submitIssueReport({
        data: {
          kind,
          details,
          pagePath: window.location.pathname,
          threadId,
          ...(messageId ? { messageId } : {}),
        },
      });
      if (result.ok) setSuccess(result);
      else setError(result.message);
    } catch {
      setError("We couldn't send this report. Your details are still here — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
        {success ? (
          <div className="flex flex-col gap-5" role="status" aria-live="polite">
            <DialogHeader>
              <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
                <CircleCheck className="size-5" aria-hidden />
              </div>
              <DialogTitle>Report {success.identifier} sent</DialogTitle>
              <DialogDescription>
                Thanks for helping us improve Ficta. If we need more detail, we'll contact you at{" "}
                {success.reporterEmail}.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>{messageId ? "Report this response" : "Report an issue"}</DialogTitle>
              <DialogDescription>
                {messageId
                  ? "Send a bug or feedback about this response directly to the Ficta team."
                  : "Send a bug or feedback directly to the Ficta team."}
              </DialogDescription>
            </DialogHeader>

            <fieldset className="grid grid-cols-2 gap-2" disabled={submitting}>
              <legend className="mb-2 text-sm font-medium">Report type</legend>
              <ReportKindOption value="bug" selected={kind === "bug"} onSelect={setKind}>
                Bug
              </ReportKindOption>
              <ReportKindOption value="feedback" selected={kind === "feedback"} onSelect={setKind}>
                Feedback
              </ReportKindOption>
            </fieldset>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={detailsId}>What happened?</Label>
                <span className="text-xs tabular-nums text-muted-foreground" aria-hidden>
                  {details.length.toLocaleString("en-US")} / {ISSUE_REPORT_DETAILS_MAX.toLocaleString("en-US")}
                </span>
              </div>
              <Textarea
                id={detailsId}
                value={details}
                onChange={(event) => {
                  setDetails(event.target.value);
                  if (error) setError("");
                }}
                placeholder="Tell us what you expected and what happened."
                maxLength={ISSUE_REPORT_DETAILS_MAX}
                required
                autoFocus
                disabled={submitting}
                aria-describedby={`${detailsHelpId}${error ? ` ${errorId}` : ""}`}
                aria-invalid={error ? true : undefined}
                className="min-h-36"
              />
              <p id={detailsHelpId} className="text-xs leading-5 text-muted-foreground">
                Include steps we can follow if you're reporting a bug.
              </p>
            </div>

            <div className="flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
              <p>
                We'll include {reporterEmail}, this page and chat ID, {messageId ? "the selected response ID, " : ""}
                your browser, workspace, and app build. Chat messages, attachments, protected values, and diagnostic
                trace bodies are never included.
              </p>
            </div>

            {error ? (
              <div
                id={errorId}
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={!details.trim() || submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {submitting ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportKindOption({
  value,
  selected,
  onSelect,
  children,
}: {
  value: ReportKind;
  selected: boolean;
  onSelect: (kind: ReportKind) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs transition-[color,background-color,box-shadow] has-[:checked]:border-foreground has-[:checked]:bg-accent has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 dark:bg-input/30">
      <input
        type="radio"
        name="report-kind"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      {children}
    </label>
  );
}
