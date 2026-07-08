import { memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { hasRestoreHighlightMarkers, RESTORE_HIGHLIGHT_TAG, restoreHighlightsToHtml } from "@/lib/restore-highlights";

const RESTORE_COMPONENTS = {
  [RESTORE_HIGHLIGHT_TAG]: ({ children }: { children?: ReactNode }) => (
    <mark className="rounded-[3px] bg-amber-100 px-0.5 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-300/20 dark:text-amber-100 dark:ring-amber-400/30">
      {children}
    </mark>
  ),
};

const RESTORE_ALLOWED_TAGS = { [RESTORE_HIGHLIGHT_TAG]: [] };
const RESTORE_LITERAL_TAGS = [RESTORE_HIGHLIGHT_TAG];

/**
 * The markdown seam. Streamdown renders GFM markdown and gracefully tolerates the unterminated
 * blocks that appear mid-stream (open code fences, half-written tables), with syntax-highlighted,
 * copyable code blocks built in. Swap the dependency here without touching callers.
 */
const Markdown = memo(function Markdown({ content }: { content: string }) {
  const hasHighlights = hasRestoreHighlightMarkers(content);
  return (
    <Streamdown
      allowedTags={hasHighlights ? RESTORE_ALLOWED_TAGS : undefined}
      className="max-w-none space-y-3 text-[0.95rem] leading-relaxed"
      components={hasHighlights ? RESTORE_COMPONENTS : undefined}
      literalTagContent={hasHighlights ? RESTORE_LITERAL_TAGS : undefined}
    >
      {hasHighlights ? restoreHighlightsToHtml(content) : content}
    </Streamdown>
  );
});

export default Markdown;
