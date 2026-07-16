import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "@/components/chat/Markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type DocxDownload, DocxDownloadContext } from "@/lib/documents/use-docx-download";
import type { ProtectionHighlightAnnotation } from "@/lib/restore-highlights";

/**
 * SSR-renders the real Markdown component (same approach as markdown-code-render.test.ts) and asserts
 * a `ficta:document` fence becomes a DocumentCard — typeset prose with the download header — instead of
 * a monospace code block, and that protection annotations survive the split into fence coordinates.
 */

const CONTRACT = "# Consulting Agreement\n\n## 1. Services\n\nAurora Corp shall provide services.";
const FENCED = `Here is the draft:\n\n\`\`\`ficta:document title="Consulting Agreement"\n${CONTRACT}\n\`\`\`\n\nAnything else?`;

function render(content: string, annotations?: ProtectionHighlightAnnotation[], docx?: DocxDownload): string {
  const markdown = createElement(Markdown, { content, annotations });
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      docx ? createElement(DocxDownloadContext.Provider, { value: docx }, markdown) : markdown,
    ),
  );
}

describe("DocumentCard rendering", () => {
  it("renders a closed fence as a typeset card, not a code block", () => {
    const markup = render(FENCED, undefined, { status: "ready", download: () => {} });
    expect(markup).toContain("Consulting Agreement"); // header title
    expect(markup).toContain("<h2"); // fence body is prose, not <code>
    expect(markup).not.toContain("ficta:document"); // fence syntax never surfaces
    expect(markup).toContain("Here is the draft:"); // commentary before the fence
    expect(markup).toContain("Anything else?"); // commentary after the fence
    expect(markup).toContain("Download as Word");
    expect(markup).toContain("Formatting is regenerated");
  });

  it("shows drafting progress while the fence is unterminated", () => {
    const streaming = `Working on it:\n\n\`\`\`ficta:document title="NDA"\n# NDA\n\n## 3. Term`;
    const markup = render(streaming);
    expect(markup).toContain("Drafting — 3. Term");
    expect(markup).not.toContain("Download as Word");
    expect(markup).not.toContain("Formatting is regenerated");
  });

  it("hides the download button when no bubble provides the context", () => {
    const markup = render(FENCED);
    expect(markup).toContain("Consulting Agreement");
    expect(markup).not.toContain("Download as Word");
  });

  it("remaps protection annotations into the fence so restored values stay highlighted", () => {
    const value = "Aurora Corp";
    const start = FENCED.indexOf(value);
    const annotations: ProtectionHighlightAnnotation[] = [
      {
        start,
        end: start + value.length,
        surrogate: "FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH",
        origin: "detected",
        direction: "restored",
      },
    ];
    const markup = render(FENCED, annotations);
    // The value renders as a ProtectionMark (<mark> tooltip trigger), and the internal highlight tag
    // never leaks as literal text — same invariant markdown-code-render.test.ts holds for code regions.
    expect(markup).toMatch(/<mark[^>]*>Aurora Corp<\/mark>/);
    expect(markup).not.toContain("ficta-protection-restored");
  });
});
