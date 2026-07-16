import type { UIMessage } from "@tanstack/ai-react";
import {
  protectionAnnotationsFromPart,
  protectionTextSegments,
  type RestoreHighlightDisplayMode,
} from "@/lib/restore-highlights";

/**
 * Build the Markdown copied from an assistant response. Only visible answer text is included: reasoning
 * and tool metadata stay out of the clipboard, while protected values follow the active display mode.
 */
export function assistantResponseClipboardText(message: UIMessage, displayMode: RestoreHighlightDisplayMode): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) =>
      protectionTextSegments(part.content, protectionAnnotationsFromPart(part, "restored"), displayMode)
        .map((segment) => segment.text)
        .join(""),
    )
    .join("");
}
