import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageActions } from "@/components/chat/MessageActions";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderActions(onReport?: (messageId: string) => void): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(MessageActions, {
        text: "Response text",
        messageId: "assistant-1",
        onReport,
      }),
    ),
  );
}

describe("response reporting action", () => {
  it("renders immediately after Copy when reporting is available", () => {
    const markup = renderActions(() => {});
    const copyPosition = markup.indexOf('aria-label="Copy response"');
    const reportPosition = markup.indexOf('aria-label="Report this response"');

    expect(copyPosition).toBeGreaterThan(-1);
    expect(reportPosition).toBeGreaterThan(copyPosition);
  });

  it("is absent when reporting is unavailable", () => {
    expect(renderActions()).not.toContain('aria-label="Report this response"');
  });
});
