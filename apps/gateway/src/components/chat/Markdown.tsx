import type { ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import { mermaid } from "@streamdown/mermaid";
import { memo, type ReactNode, useMemo } from "react";
import { Streamdown } from "streamdown";
import { lastDocumentBlock, lastHeading } from "@/lib/documents/document-blocks";
import {
  type ProtectionHighlightAnnotation,
  protectionHighlightTag,
  type RestoreHighlightDisplayMode,
  renderProtectionHighlights,
} from "@/lib/restore-highlights";
import { DocumentCard } from "./DocumentCard";
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
 * The markdown seam, now in two layers. `Markdown` (exported) splits the text around the last
 * `ficta:document` fence so the contract renders inside a DocumentCard — typeset like prose, with
 * the drafting progress / Download header — instead of as a monospace code block; commentary before
 * and after the fence renders normally. Everything else is `MarkdownSegment`: Streamdown rendering
 * GFM that gracefully tolerates the unterminated blocks that appear mid-stream. Protection
 * annotations are span offsets on the whole text, so the split remaps them into each segment.
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
  const block = useMemo(() => lastDocumentBlock(content), [content]);
  if (!block) {
    return <MarkdownSegment content={content} annotations={annotations} restoreDisplayMode={restoreDisplayMode} />;
  }

  const before = content.slice(0, block.start);
  const after = block.closed ? content.slice(block.end) : "";
  return (
    <>
      {before.trim() ? (
        <MarkdownSegment
          content={before}
          annotations={sliceAnnotations(annotations, 0, block.start)}
          restoreDisplayMode={restoreDisplayMode}
        />
      ) : null}
      <DocumentCard
        title={block.attrs.title?.trim() || undefined}
        closed={block.closed}
        progress={block.closed ? undefined : lastHeading(block.content)}
      >
        <MarkdownSegment
          content={block.content}
          annotations={sliceAnnotations(annotations, block.contentStart, block.contentEnd)}
          restoreDisplayMode={restoreDisplayMode}
        />
      </DocumentCard>
      {after.trim() ? (
        <MarkdownSegment
          content={after}
          annotations={sliceAnnotations(annotations, block.end, content.length)}
          restoreDisplayMode={restoreDisplayMode}
        />
      ) : null}
    </>
  );
});

export default Markdown;

/** Annotations inside [start, end), shifted to segment-relative offsets. A span that straddles a
 *  fence boundary cannot correspond to a real protected value, so it is dropped rather than split. */
function sliceAnnotations(
  annotations: ProtectionHighlightAnnotation[] | undefined,
  start: number,
  end: number,
): ProtectionHighlightAnnotation[] | undefined {
  if (!annotations?.length) return annotations;
  return annotations
    .filter((annotation) => annotation.start >= start && annotation.end <= end)
    .map((annotation) => ({ ...annotation, start: annotation.start - start, end: annotation.end - start }));
}

const MarkdownSegment = memo(function MarkdownSegment({
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
