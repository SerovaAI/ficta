import type { ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProtectionHighlightDirection, RestoreHighlightDisplayMode } from "@/lib/restore-highlights";

export function ProtectionMark({
  children,
  origin,
  direction,
  displayMode = "values",
}: {
  children: ReactNode;
  origin: ProtectionPreviewOrigin;
  direction: ProtectionHighlightDirection;
  displayMode?: RestoreHighlightDisplayMode;
}) {
  const { tooltipLabel, explanation, borderClass } = protectionHighlightPresentation(origin, direction);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <mark
          className={`cursor-help rounded-[3px] border-b-2 bg-emerald-100 px-0.5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-emerald-950/60 ${displayMode === "surrogates" ? "font-mono text-[0.86em]" : ""} ${borderClass}`}
          // A focusable mark keeps arbitrary inline text keyboard-accessible without creating invalid
          // interactive nesting inside markdown links or other prose.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is the keyboard trigger for this tooltip
          tabIndex={0}
        >
          {children}
        </mark>
      </TooltipTrigger>
      <TooltipContent className="max-w-64" sideOffset={6}>
        <span className="block font-medium">{tooltipLabel}</span>
        <span className="mt-0.5 block opacity-80">{explanation}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function protectionHighlightPresentation(
  origin: ProtectionPreviewOrigin,
  direction: ProtectionHighlightDirection,
): { tooltipLabel: string; explanation: string; borderClass: string } {
  const source = origin === "user" ? "Protected by you" : origin === "registry" ? "Protected Registry" : "Detected PII";
  const tooltipLabel = `${source} · ${direction === "restored" ? "restored locally" : "redacted before sending"}`;
  const explanation =
    direction === "restored"
      ? "Replaced with a protected token before reaching the model."
      : "The model received the protected token instead of this value.";
  const borderClass =
    origin === "user"
      ? "border-foreground"
      : origin === "detected"
        ? "border-emerald-600 border-dashed"
        : "border-emerald-600";

  return { tooltipLabel, explanation, borderClass };
}
