import { Check, Copy, FileDown, Flag, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocxDownload } from "@/lib/documents/use-docx-download";

type CopyStatus = "idle" | "copied" | "error";

/** Persistent actions on a completed assistant turn: copy or open a report for the response, download it as Word,
 *  or regenerate the latest response. The report action forwards the response ID, never its text. */
export function MessageActions({
  text,
  messageId,
  onReport,
  docx,
  onRegenerate,
  canRegenerate,
}: {
  text: string;
  messageId: string;
  onReport?: (messageId: string) => void;
  docx?: DocxDownload;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
      resetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1500);
    } catch {
      setCopyStatus("error");
    }
  };

  const copyLabel =
    copyStatus === "copied" ? "Response copied" : copyStatus === "error" ? "Retry copying response" : "Copy response";
  const copyTooltip = copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : "Copy response";

  return (
    // `relative` is load-bearing: the sr-only status span is position:absolute, and without a
    // positioned ancestor its containing block is the document — on long threads every actions row
    // then extends the page's scrollable height to its transcript position, escaping the message
    // scroller's overflow clip and giving the whole page a phantom scrollbar.
    <fieldset className="relative m-0 flex min-w-0 items-center gap-0.5 border-0 p-0" aria-label="Response actions">
      <span className="sr-only" role="status" aria-live="polite">
        {copyStatus === "copied" ? "Response copied to clipboard." : ""}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`size-7 ${copyStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}
            onClick={copy}
            aria-label={copyLabel}
          >
            {copyStatus === "copied" ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copyTooltip}</TooltipContent>
      </Tooltip>
      {onReport ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={() => onReport(messageId)}
              aria-label="Report this response"
            >
              <Flag className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Report this response</TooltipContent>
        </Tooltip>
      ) : null}
      {copyStatus === "error" ? (
        <span className="text-destructive text-xs" role="alert">
          Copy failed
        </span>
      ) : null}
      {docx && docx.status !== "unavailable" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* aria-disabled instead of disabled so the blocked explanation stays reachable by
                hover and focus (a disabled button receives neither); the click is a no-op while
                blocked. */}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground aria-disabled:opacity-50"
              onClick={docx.status === "blocked" ? undefined : docx.download}
              aria-disabled={docx.status === "blocked" || docx.status === "rendering"}
              aria-label={docx.message ?? "Download as Word"}
            >
              {docx.status === "rendering" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <FileDown className="size-3.5" aria-hidden />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{docx.message ?? "Download as Word"}</TooltipContent>
        </Tooltip>
      ) : null}
      {onRegenerate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={onRegenerate}
              disabled={!canRegenerate}
              aria-label="Regenerate"
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Regenerate</TooltipContent>
        </Tooltip>
      ) : null}
    </fieldset>
  );
}
