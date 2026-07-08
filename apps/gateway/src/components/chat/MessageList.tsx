import type { UIMessage } from "@tanstack/ai-react";
import { useEffect, useRef, useState } from "react";
import type { RestoreHighlightDisplayMode } from "@/lib/restore-highlights";
import { resolveSuggestedPrompts } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";

export function MessageList({
  messages,
  isLoading,
  onRegenerate,
  onPickSuggestion,
  restoreDisplayMode,
}: {
  messages: UIMessage[];
  isLoading: boolean;
  onRegenerate: () => void;
  onPickSuggestion: (prompt: string) => void;
  restoreDisplayMode: RestoreHighlightDisplayMode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastIndex = messages.length - 1;
  const suggestions = resolveSuggestedPrompts(useInstanceSettings());

  // Announce the assistant's reply once, on completion. The transcript itself is NOT an aria-live region:
  // streaming it live would spam screen readers with a re-announcement on every partial token.
  const [announcement, setAnnouncement] = useState("");
  const wasLoading = useRef(isLoading);
  useEffect(() => {
    if (wasLoading.current && !isLoading) {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") setAnnouncement("Assistant response complete.");
    }
    wasLoading.current = isLoading;
  }, [isLoading, messages]);

  // Follow the stream only while the user is already parked near the bottom; if they scrolled up to
  // read, don't yank the viewport back down.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as content grows during streaming
  useEffect(() => {
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
          <EmptyState suggestions={suggestions} onPick={onPickSuggestion} />
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" aria-busy={isLoading}>
        {messages.map((message, i) => {
          const isLast = i === lastIndex;
          const streaming = isLoading && isLast && message.role === "assistant";
          const canRegen = isLast && message.role === "assistant" && !isLoading;
          return (
            <MessageBubble
              key={message.id}
              message={message}
              streaming={streaming}
              onRegenerate={canRegen ? onRegenerate : undefined}
              canRegenerate={canRegen}
              restoreDisplayMode={restoreDisplayMode}
            />
          );
        })}
      </div>
    </div>
  );
}
