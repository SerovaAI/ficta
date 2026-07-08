import type { UIMessage } from "@tanstack/ai-react";
import { hasRestoreHighlightMarkers, stripRestoreHighlightMarkers } from "@/lib/restore-highlights";

type TextPartKey = "content" | "text";

export type RestoreHighlightCache = Map<string, Map<number, string>>;

export function createRestoreHighlightCache(): RestoreHighlightCache {
  return new Map();
}

/**
 * TanStack AI can replace the live streamed message with a finished message whose text has already
 * had trace markers stripped. Keep the marker-bearing text only in memory for the current session so
 * the privacy toggle remains available, while persisted/replayed messages stay marker-free.
 */
export function messagesWithCachedRestoreHighlights(messages: UIMessage[], cache: RestoreHighlightCache): UIMessage[] {
  let changed = false;
  const liveKeys = new Map<string, Set<number>>();

  const mapped = messages.map((message) => {
    let partsChanged = false;
    const nextParts = message.parts.map((part, partIndex) => {
      const text = textPart(part);
      if (!text) return part;

      let messageCache = cache.get(message.id);
      const livePartKeys = liveKeys.get(message.id) ?? new Set<number>();
      livePartKeys.add(partIndex);
      liveKeys.set(message.id, livePartKeys);

      if (hasRestoreHighlightMarkers(text.value)) {
        messageCache ??= new Map();
        messageCache.set(partIndex, text.value);
        cache.set(message.id, messageCache);
        return part;
      }

      const cached = messageCache?.get(partIndex);
      if (cached && stripRestoreHighlightMarkers(cached) === text.value) {
        partsChanged = true;
        return { ...part, [text.key]: cached };
      }

      messageCache?.delete(partIndex);
      if (messageCache?.size === 0) cache.delete(message.id);
      return part;
    });

    if (!partsChanged) return message;
    changed = true;
    return { ...message, parts: nextParts as UIMessage["parts"] };
  });

  pruneRestoreHighlightCache(cache, liveKeys);
  return changed ? mapped : messages;
}

function textPart(part: UIMessage["parts"][number]): { key: TextPartKey; value: string } | undefined {
  if (part.type !== "text") return undefined;
  const maybeContent = part as { content?: unknown; text?: unknown };
  if (typeof maybeContent.content === "string") return { key: "content", value: maybeContent.content };
  if (typeof maybeContent.text === "string") return { key: "text", value: maybeContent.text };
  return undefined;
}

function pruneRestoreHighlightCache(cache: RestoreHighlightCache, liveKeys: Map<string, Set<number>>): void {
  for (const [messageId, parts] of cache) {
    const liveParts = liveKeys.get(messageId);
    if (!liveParts) {
      cache.delete(messageId);
      continue;
    }
    for (const partIndex of parts.keys()) if (!liveParts.has(partIndex)) parts.delete(partIndex);
    if (parts.size === 0) cache.delete(messageId);
  }
}
