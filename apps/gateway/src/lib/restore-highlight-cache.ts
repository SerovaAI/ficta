import type { UIMessage } from "@tanstack/ai-react";
import { hasRestoreHighlightMarkers, stripRestoreHighlightMarkers } from "@/lib/restore-highlights";

type TextPartKey = "content" | "text";

type PartCache = Map<number, string>;

export interface RestoreHighlightCache {
  byMessageId: Map<string, PartCache>;
  byPosition: Map<number, PartCache>;
}

export function createRestoreHighlightCache(): RestoreHighlightCache {
  return { byMessageId: new Map(), byPosition: new Map() };
}

export function clearRestoreHighlightCache(cache: RestoreHighlightCache): void {
  cache.byMessageId.clear();
  cache.byPosition.clear();
}

/**
 * TanStack AI can replace the live streamed message with a finished message whose text has already
 * had trace markers stripped. Keep the marker-bearing text only in memory for the current session so
 * the privacy toggle remains available, while persisted/replayed messages stay marker-free.
 */
export function messagesWithCachedRestoreHighlights(messages: UIMessage[], cache: RestoreHighlightCache): UIMessage[] {
  let changed = false;
  const liveMessageParts = new Map<string, Set<number>>();
  const livePositionParts = new Map<number, Set<number>>();

  const mapped = messages.map((message, messageIndex) => {
    let partsChanged = false;
    const nextParts = message.parts.map((part, partIndex) => {
      const text = textPart(part);
      if (!text) return part;

      const messageParts = liveMessageParts.get(message.id) ?? new Set<number>();
      messageParts.add(partIndex);
      liveMessageParts.set(message.id, messageParts);
      const positionParts = livePositionParts.get(messageIndex) ?? new Set<number>();
      positionParts.add(partIndex);
      livePositionParts.set(messageIndex, positionParts);

      if (hasRestoreHighlightMarkers(text.value)) {
        setCachedPart(cache.byMessageId, message.id, partIndex, text.value);
        setCachedPart(cache.byPosition, messageIndex, partIndex, text.value);
        return part;
      }

      const cached =
        cache.byMessageId.get(message.id)?.get(partIndex) ?? cache.byPosition.get(messageIndex)?.get(partIndex);
      if (cached && stripRestoreHighlightMarkers(cached) === text.value) {
        partsChanged = true;
        return { ...part, [text.key]: cached };
      }

      deleteCachedPart(cache.byMessageId, message.id, partIndex);
      deleteCachedPart(cache.byPosition, messageIndex, partIndex);
      return part;
    });

    if (!partsChanged) return message;
    changed = true;
    return { ...message, parts: nextParts as UIMessage["parts"] };
  });

  pruneRestoreHighlightCache(cache.byMessageId, liveMessageParts);
  pruneRestoreHighlightCache(cache.byPosition, livePositionParts);
  return changed ? mapped : messages;
}

function textPart(part: UIMessage["parts"][number]): { key: TextPartKey; value: string } | undefined {
  if (part.type !== "text") return undefined;
  const maybeContent = part as { content?: unknown; text?: unknown };
  if (typeof maybeContent.content === "string") return { key: "content", value: maybeContent.content };
  if (typeof maybeContent.text === "string") return { key: "text", value: maybeContent.text };
  return undefined;
}

function setCachedPart<K>(cache: Map<K, PartCache>, key: K, partIndex: number, value: string): void {
  const parts = cache.get(key) ?? new Map<number, string>();
  parts.set(partIndex, value);
  cache.set(key, parts);
}

function deleteCachedPart<K>(cache: Map<K, PartCache>, key: K, partIndex: number): void {
  const parts = cache.get(key);
  parts?.delete(partIndex);
  if (parts?.size === 0) cache.delete(key);
}

function pruneRestoreHighlightCache<K>(cache: Map<K, PartCache>, liveKeys: Map<K, Set<number>>): void {
  for (const [key, parts] of cache) {
    const liveParts = liveKeys.get(key);
    if (!liveParts) {
      cache.delete(key);
      continue;
    }
    for (const partIndex of parts.keys()) if (!liveParts.has(partIndex)) parts.delete(partIndex);
    if (parts.size === 0) cache.delete(key);
  }
}
