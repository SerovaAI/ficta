import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "@/components/chat/Markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProtectionHighlightAnnotation } from "@/lib/restore-highlights";

/**
 * Regression test for restored-entity tags leaking as literal text: render the real Markdown component
 * (through Streamdown) and assert the custom highlight tags never surface in the emitted markup when a
 * restored value sits inside a code region. SSR skips effects (syntax highlighting, mermaid), which is
 * fine — the leak happened at parse time, not in effects.
 */

const surrogate = "FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH";

function annotate(content: string, value: string): ProtectionHighlightAnnotation[] {
  const annotations: ProtectionHighlightAnnotation[] = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(value, from);
    if (start === -1) return annotations;
    annotations.push({ start, end: start + value.length, surrogate, origin: "detected", direction: "restored" });
    from = start + value.length;
  }
}

function renderMarkdown(content: string, annotations: ProtectionHighlightAnnotation[]): string {
  // ProtectionMark renders inside a Radix tooltip, which needs the app's TooltipProvider (ChatView provides
  // it in production).
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { content, annotations })));
}

describe("Markdown code-region rendering", () => {
  it("keeps a restored value in a fenced diagram verbatim, with no literal highlight tags", () => {
    const content = "Parties:\n\n```\nAurora Corp --> Beacon Ltd\n```\n\nAurora Corp retained the firm.";
    const markup = renderMarkdown(content, annotate(content, "Aurora Corp"));

    expect(markup).not.toContain("ficta-protection-restored");
    expect(markup).toContain("Aurora Corp --&gt; Beacon Ltd");
    // The prose occurrence still renders as a highlight mark (element markup splits the sentence).
    expect(markup).toContain("Aurora Corp");
    expect(markup).toContain("retained the firm.");
  });

  it("renders a prose-only restored value as a highlight mark, not literal tags", () => {
    const content = "Aurora Corp retained the firm.";
    const markup = renderMarkdown(content, annotate(content, "Aurora Corp"));

    expect(markup).not.toContain("&lt;ficta-protection-restored");
    expect(markup).toContain("Aurora Corp");
  });

  it("does not leak tags into inline code", () => {
    const content = "The matter is filed under `Aurora Corp` internally.";
    const markup = renderMarkdown(content, annotate(content, "Aurora Corp"));

    expect(markup).not.toContain("ficta-protection-restored");
    expect(markup).toContain("Aurora Corp");
  });

  it("does not leak tags while a streamed fence is still open", () => {
    const content = "Diagram:\n\n```\nAurora Corp --> Beac";
    const markup = renderMarkdown(content, annotate(content, "Aurora Corp"));

    expect(markup).not.toContain("ficta-protection-restored");
    expect(markup).toContain("Aurora Corp");
  });
});
