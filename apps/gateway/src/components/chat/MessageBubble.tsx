import type { UIMessage } from "@tanstack/ai-react";
import type { RestoreHighlightDisplayMode } from "@/lib/restore-highlights";
import { cn } from "@/lib/utils";
import { MessageActions } from "./MessageActions";
import { MessageParts } from "./MessageParts";
import { StreamingIndicator } from "./StreamingIndicator";

// The display transcript already carries marker-free visible text (see use-restore-highlight-display),
// so copy/aria text is a plain join — no marker stripping needed here.
function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.content)
    .join("");
}

export function MessageBubble({
  message,
  streaming,
  onRegenerate,
  canRegenerate,
  restoreDisplayMode,
}: {
  message: UIMessage;
  streaming?: boolean;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  restoreDisplayMode: RestoreHighlightDisplayMode;
}) {
  const isUser = message.role === "user";
  const text = textOf(message);
  const hasVisible = message.parts.some((p) => p.type !== "text" || p.content.length > 0);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className={cn("min-w-0 text-foreground")}>
        {streaming && !hasVisible ? (
          <StreamingIndicator />
        ) : (
          <MessageParts parts={message.parts} restoreDisplayMode={restoreDisplayMode} />
        )}
      </div>
      {!streaming && text.length > 0 ? (
        <MessageActions text={text} onRegenerate={onRegenerate} canRegenerate={canRegenerate} />
      ) : null}
    </div>
  );
}
