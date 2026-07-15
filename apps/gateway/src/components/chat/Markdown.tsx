import type { ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import { mermaid } from "@streamdown/mermaid";
import { memo, type ReactNode, useMemo } from "react";
import { Streamdown } from "streamdown";
import {
  type ProtectionHighlightAnnotation,
  protectionHighlightTag,
  type RestoreHighlightDisplayMode,
  renderProtectionHighlights,
} from "@/lib/restore-highlights";
import { ProtectionMark, protectionHighlightPresentation } from "./ProtectionMark";

const RESTORE_ORIGINS = ["registry", "detected", "user"] as const;
const RESTORE_DIRECTIONS = ["redacted", "restored"] as const;
const RESTORE_TAGS = RESTORE_DIRECTIONS.flatMap((direction) =>
  RESTORE_ORIGINS.map((origin) => protectionHighlightTag(direction, origin)),
);
const RESTORE_ALLOWED_TAGS = Object.fromEntries(RESTORE_TAGS.map((tag) => [tag, []]));
const RESTORE_LITERAL_TAGS = RESTORE_TAGS;
// Module-level so the memoized component's props stay referentially stable across renders.
const STREAMDOWN_PLUGINS = { mermaid };

/**
 * The markdown seam. Streamdown renders GFM markdown and gracefully tolerates the unterminated
 * blocks that appear mid-stream (open code fences, half-written tables), with syntax-highlighted,
 * copyable code blocks built in. Swap the dependency here without touching callers.
 */
const Markdown = memo(function Markdown({
  content,
  annotations,
  restoreDisplayMode = "values",
}: {
  content: string;
  annotations?: ProtectionHighlightAnnotation[];
  restoreDisplayMode?: RestoreHighlightDisplayMode;
}) {
  const { html, highlighted } = useMemo(
    () => renderProtectionHighlights(content, annotations ?? [], restoreDisplayMode),
    [annotations, content, restoreDisplayMode],
  );
  const restoreComponents = useMemo(() => restoreHighlightComponents(restoreDisplayMode), [restoreDisplayMode]);
  return (
    <Streamdown
      allowedTags={highlighted ? RESTORE_ALLOWED_TAGS : undefined}
      className="max-w-none space-y-3 text-[0.95rem] leading-relaxed"
      components={highlighted ? restoreComponents : undefined}
      literalTagContent={highlighted ? RESTORE_LITERAL_TAGS : undefined}
      plugins={STREAMDOWN_PLUGINS}
    >
      {html}
    </Streamdown>
  );
});

export default Markdown;

function restoreHighlightComponents(displayMode: RestoreHighlightDisplayMode) {
  return Object.fromEntries(
    RESTORE_DIRECTIONS.flatMap((direction) =>
      RESTORE_ORIGINS.map((origin) => [
        protectionHighlightTag(direction, origin),
        ({ children }: { children?: ReactNode }) => (
          <ProtectionMark displayMode={displayMode} direction={direction} origin={origin}>
            {children}
          </ProtectionMark>
        ),
      ]),
    ),
  );
}

/** Mirrors ProtectionReview's three-way key for restored assistant values. */
export function restoreHighlightPresentation(origin: ProtectionPreviewOrigin): {
  tooltipLabel: string;
  borderClass: string;
} {
  const { tooltipLabel, borderClass } = protectionHighlightPresentation(origin, "restored");
  return { tooltipLabel, borderClass };
}
