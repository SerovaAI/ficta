import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type CopyStatus = "idle" | "copied" | "error";

/** Persistent actions on a completed assistant turn: copy the text, or regenerate the latest response. */
export function MessageActions({
  text,
  onRegenerate,
  canRegenerate,
}: {
  text: string;
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
    <fieldset className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0" aria-label="Response actions">
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
      {copyStatus === "error" ? (
        <span className="text-destructive text-xs" role="alert">
          Copy failed
        </span>
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
