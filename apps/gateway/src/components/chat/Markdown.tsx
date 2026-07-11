import type { ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import { memo, type ReactNode, useMemo } from "react";
import { Streamdown } from "streamdown";
import {
  type RestoreHighlight,
  type RestoreHighlightDisplayMode,
  renderVisibleHighlights,
  restoreHighlightTag,
} from "@/lib/restore-highlights";

const RESTORE_ORIGINS = ["registry", "detected", "user"] as const;
const RESTORE_TAGS = RESTORE_ORIGINS.map(restoreHighlightTag);
const RESTORE_ALLOWED_TAGS = Object.fromEntries(RESTORE_TAGS.map((tag) => [tag, []]));
const RESTORE_LITERAL_TAGS = RESTORE_TAGS;

/**
 * The markdown seam. Streamdown renders GFM markdown and gracefully tolerates the unterminated
 * blocks that appear mid-stream (open code fences, half-written tables), with syntax-highlighted,
 * copyable code blocks built in. Swap the dependency here without touching callers.
 */
const Markdown = memo(function Markdown({
  content,
  restorations,
  restoreDisplayMode = "values",
}: {
  content: string;
  restorations?: RestoreHighlight[];
  restoreDisplayMode?: RestoreHighlightDisplayMode;
}) {
  const { html, highlighted } = useMemo(
    () => renderVisibleHighlights(content, restorations ?? [], restoreDisplayMode),
    [content, restorations, restoreDisplayMode],
  );
  const restoreComponents = useMemo(() => restoreHighlightComponents(restoreDisplayMode), [restoreDisplayMode]);
  return (
    <Streamdown
      allowedTags={highlighted ? RESTORE_ALLOWED_TAGS : undefined}
      className="max-w-none space-y-3 text-[0.95rem] leading-relaxed"
      components={highlighted ? restoreComponents : undefined}
      literalTagContent={highlighted ? RESTORE_LITERAL_TAGS : undefined}
    >
      {html}
    </Streamdown>
  );
});

export default Markdown;

function restoreHighlightComponents(displayMode: RestoreHighlightDisplayMode) {
  return Object.fromEntries(
    RESTORE_ORIGINS.map((origin) => [
      restoreHighlightTag(origin),
      ({ children }: { children?: ReactNode }) => (
        <RestoreMark displayMode={displayMode} origin={origin}>
          {children}
        </RestoreMark>
      ),
    ]),
  );
}

function RestoreMark({
  children,
  displayMode,
  origin,
}: {
  children?: ReactNode;
  displayMode: RestoreHighlightDisplayMode;
  origin: ProtectionPreviewOrigin;
}) {
  if (displayMode === "surrogates") {
    return (
      <mark className="rounded-[3px] bg-muted px-1 font-mono text-[0.86em] text-foreground ring-1 ring-border dark:bg-muted/70">
        {children}
      </mark>
    );
  }

  const { title, borderClass } = restoreHighlightPresentation(origin);

  return (
    <mark
      className={`rounded-[3px] border-b-2 bg-emerald-100 px-0.5 text-foreground dark:bg-emerald-950/60 ${borderClass}`}
      title={title}
    >
      {children}
    </mark>
  );
}

/** Mirrors ProtectionReview's three-way key for restored assistant values. */
export function restoreHighlightPresentation(origin: ProtectionPreviewOrigin): {
  title: string;
  borderClass: string;
} {
  const title =
    origin === "user"
      ? "Protected by you — restored locally"
      : origin === "registry"
        ? "Protected Registry — restored locally"
        : "Detected PII — restored locally";
  const borderClass =
    origin === "user"
      ? "border-foreground"
      : origin === "detected"
        ? "border-emerald-600 border-dashed"
        : "border-emerald-600";

  return { title, borderClass };
}
