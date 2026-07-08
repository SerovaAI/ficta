import { memo, type ReactNode, useMemo } from "react";
import { Streamdown } from "streamdown";
import {
  hasRestoreHighlightMarkers,
  RESTORE_HIGHLIGHT_TAG,
  type RestoreHighlightDisplayMode,
  restoreHighlightsToHtml,
} from "@/lib/restore-highlights";

const RESTORE_ALLOWED_TAGS = { [RESTORE_HIGHLIGHT_TAG]: [] };
const RESTORE_LITERAL_TAGS = [RESTORE_HIGHLIGHT_TAG];

/**
 * The markdown seam. Streamdown renders GFM markdown and gracefully tolerates the unterminated
 * blocks that appear mid-stream (open code fences, half-written tables), with syntax-highlighted,
 * copyable code blocks built in. Swap the dependency here without touching callers.
 */
export const Markdown = memo(function Markdown({
  content,
  restoreDisplayMode = "values",
}: {
  content: string;
  restoreDisplayMode?: RestoreHighlightDisplayMode;
}) {
  const hasHighlights = hasRestoreHighlightMarkers(content);
  const restoreComponents = useMemo(() => restoreHighlightComponents(restoreDisplayMode), [restoreDisplayMode]);
  return (
    <Streamdown
      allowedTags={hasHighlights ? RESTORE_ALLOWED_TAGS : undefined}
      className="max-w-none space-y-3 text-[0.95rem] leading-relaxed"
      components={hasHighlights ? restoreComponents : undefined}
      literalTagContent={hasHighlights ? RESTORE_LITERAL_TAGS : undefined}
    >
      {hasHighlights ? restoreHighlightsToHtml(content, restoreDisplayMode) : content}
    </Streamdown>
  );
});

export default Markdown;

function restoreHighlightComponents(displayMode: RestoreHighlightDisplayMode) {
  return {
    [RESTORE_HIGHLIGHT_TAG]: ({ children }: { children?: ReactNode }) =>
      displayMode === "surrogates" ? (
        <mark className="rounded-[3px] bg-muted px-1 font-mono text-[0.86em] text-foreground ring-1 ring-border dark:bg-muted/70">
          {children}
        </mark>
      ) : (
        <mark className="rounded-[3px] bg-amber-100 px-0.5 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-300/20 dark:text-amber-100 dark:ring-amber-400/30">
          {children}
        </mark>
      ),
  };
}
