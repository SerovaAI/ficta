import type { UIMessage } from "@tanstack/ai-react";
import { DocxDownloadContext, useDocxDownload } from "@/lib/documents/use-docx-download";
import { assistantResponseClipboardText } from "@/lib/message-copy";
import {
  protectionAnnotationsFromPart,
  protectionTextSegments,
  type RestoreHighlightDisplayMode,
} from "@/lib/restore-highlights";
import { cn } from "@/lib/utils";
import { MessageActions } from "./MessageActions";
import { MessageParts } from "./MessageParts";
import { ProtectionMark } from "./ProtectionMark";
import { StreamingIndicator } from "./StreamingIndicator";

export function MessageBubble({
  message,
  streaming,
  onReport,
  onRegenerate,
  canRegenerate,
  restoreDisplayMode,
}: {
  message: UIMessage;
  streaming?: boolean;
  onReport?: (messageId: string) => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  restoreDisplayMode: RestoreHighlightDisplayMode;
}) {
  const isUser = message.role === "user";
  const copyText = assistantResponseClipboardText(message, restoreDisplayMode);
  const hasVisible = message.parts.some((p) => p.type !== "text" || p.content.length > 0);
  // Word export of the assistant turn: pre-renders on stream completion when a document fence is
  // present, so the download (in the actions row and on the document card) saves a ready file.
  // Always exported with restored values — the display-mode toggle affects the clipboard, never the
  // client deliverable (the surrogate leak gate would refuse a "surrogates" render anyway).
  const docx = useDocxDownload({
    text: isUser ? "" : assistantResponseClipboardText(message, "values"),
    streaming: !!streaming,
  });

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground">
          <UserMessageText message={message} restoreDisplayMode={restoreDisplayMode} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className={cn("min-w-0 text-foreground")}>
        {streaming && !hasVisible ? (
          <StreamingIndicator />
        ) : (
          <DocxDownloadContext.Provider value={docx}>
            <MessageParts parts={message.parts} restoreDisplayMode={restoreDisplayMode} />
          </DocxDownloadContext.Provider>
        )}
      </div>
      {!streaming && copyText.length > 0 ? (
        <MessageActions
          text={copyText}
          messageId={message.id}
          onReport={onReport}
          docx={docx}
          onRegenerate={onRegenerate}
          canRegenerate={canRegenerate}
        />
      ) : null}
    </div>
  );
}

function UserMessageText({
  message,
  restoreDisplayMode,
}: {
  message: UIMessage;
  restoreDisplayMode: RestoreHighlightDisplayMode;
}) {
  return message.parts.map((part, partIndex) => {
    if (part.type !== "text") return null;
    const segments = protectionTextSegments(
      part.content,
      protectionAnnotationsFromPart(part, "redacted"),
      restoreDisplayMode,
    );
    return segments.map((segment, segmentIndex) =>
      segment.annotation ? (
        <ProtectionMark
          // biome-ignore lint/suspicious/noArrayIndexKey: annotations are immutable within a persisted message part
          key={`${partIndex}:${segmentIndex}`}
          direction={segment.annotation.direction}
          displayMode={restoreDisplayMode}
          origin={segment.annotation.origin}
        >
          {segment.text}
        </ProtectionMark>
      ) : (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: annotations are immutable within a persisted message part
          key={`${partIndex}:${segmentIndex}`}
        >
          {segment.text}
        </span>
      ),
    );
  });
}
