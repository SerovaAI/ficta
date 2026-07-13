import type { UIMessage } from "@tanstack/ai-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  hasRestoreHighlightMarkers,
  hasVisibleRestorations,
  parseRestoreHighlightText,
  protectionAnnotationsFromPart,
  type RestoreHighlight,
  restorationsToAnnotations,
  withProtectionAnnotations,
} from "@/lib/restore-highlights";

/**
 * Restore-highlight display metadata is ephemeral UI state, not chat data: the proxy emits it only in the
 * streamed markers, and TanStack AI replaces the live marker-bearing message with a marker-free finished
 * message the instant a stream ends. This hook is the client-only home for that metadata. It parses the
 * markers out of streamed text into a structured sidecar ({@link RestoreHighlight}), keeps it keyed by
 * turn position for the session, and re-attaches it to the authoritative (marker-free) message text by
 * locating each value at render time — so highlights survive the stream→finish swap and in-SPA thread
 * navigation without ever letting delimiter markers into `messages`, storage, or replay.
 *
 * The value-bearing cache remains session-scoped. Before a snapshot is saved, it is converted into
 * values-free coordinates under the text part's namespaced metadata, so reopened transcripts retain the
 * display evidence without persisting a second copy of the protected value or any raw delimiter marker.
 */

const HIGHLIGHT_QUERY_ROOT = "restore-highlights";

function restoreHighlightKey(threadId: string): readonly [string, string] {
  return [HIGHLIGHT_QUERY_ROOT, threadId];
}

/** Clear a thread's live highlight metadata (used when starting a fresh chat in place). */
export function clearRestoreHighlightDisplay(queryClient: QueryClient, threadId: string): void {
  queryClient.removeQueries({ queryKey: restoreHighlightKey(threadId) });
}

// position (message index) -> part index -> restorations for that part.
export type RestoreHighlightStore = Map<number, Map<number, RestoreHighlight[]>>;
// Serializable mirror persisted into React Query so the store survives a component remount.
type SerializedStore = Record<number, Record<number, RestoreHighlight[]>>;

export function createRestoreHighlightStore(): RestoreHighlightStore {
  return new Map();
}

export function useRestoreHighlightDisplay(
  threadId: string,
  messages: UIMessage[],
): {
  displayMessages: UIMessage[];
  restoreHighlightsAvailable: boolean;
  prepareMessagesForPersistence: (snapshot: UIMessage[]) => UIMessage[];
  clearRestoreHighlightsAtPosition: (position: number) => void;
} {
  const queryClient = useQueryClient();
  const storeRef = useRef<RestoreHighlightStore | undefined>(undefined);
  // Seed once per mount from the persisted mirror so highlights come back after a thread-switch remount.
  if (storeRef.current === undefined) {
    storeRef.current = deserializeStore(queryClient.getQueryData<SerializedStore>(restoreHighlightKey(threadId)));
  }
  const store = storeRef.current;

  const { displayMessages, restoreHighlightsAvailable } = deriveRestoreHighlightDisplay(messages, store);

  // Persist the current store after each message change so a subsequent remount can re-seed. Serializing a
  // handful of small entries is cheap; `messages` identity changes on every stream delta and on finish.
  // `storeRef` is mount-stable, so read it inside rather than listing it as a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-persist whenever the transcript changes
  useEffect(() => {
    const current = storeRef.current;
    if (current) queryClient.setQueryData<SerializedStore>(restoreHighlightKey(threadId), serializeStore(current));
  }, [queryClient, threadId, messages]);

  const prepareMessagesForPersistence = useCallback((snapshot: UIMessage[]) => {
    const current = storeRef.current;
    return current ? deriveRestoreHighlightDisplay(snapshot, current).displayMessages : snapshot;
  }, []);

  const clearRestoreHighlightsAtPosition = useCallback((position: number) => {
    storeRef.current?.delete(position);
  }, []);

  return {
    displayMessages,
    restoreHighlightsAvailable,
    prepareMessagesForPersistence,
    clearRestoreHighlightsAtPosition,
  };
}

/**
 * Pure core: fold `messages` against `store`, returning the display transcript and toggle availability.
 * Streaming (marker-bearing) parts are parsed and cached; finished (marker-free) parts re-attach the
 * cached restorations by turn position. Mutates `store` in place (like a cache) and prunes entries for
 * turns/parts absent this pass. Exported for testing without React.
 */
export function deriveRestoreHighlightDisplay(
  messages: UIMessage[],
  store: RestoreHighlightStore,
): { displayMessages: UIMessage[]; restoreHighlightsAvailable: boolean } {
  let changed = false;
  const livePositions = new Map<number, Set<number>>();

  const displayMessages = messages.map((message, position) => {
    if (message.role !== "assistant") return message;

    let partsChanged = false;
    const nextParts = message.parts.map((part, partIndex) => {
      const field = textField(part);
      if (!field) return part;
      recordLive(livePositions, position, partIndex);

      if (hasRestoreHighlightMarkers(field.value)) {
        const parsed = parseRestoreHighlightText(field.value);
        setStore(store, position, partIndex, parsed.restorations);
        partsChanged = true;
        return withProtectionAnnotations(
          { ...part, [field.key]: parsed.visibleText },
          restorationsToAnnotations(parsed.visibleText, parsed.restorations),
        );
      }

      if (protectionAnnotationsFromPart(part, "restored").length > 0) return part;
      const restorations = store.get(position)?.get(partIndex);
      if (restorations && restorations.length > 0 && hasVisibleRestorations(field.value, restorations)) {
        partsChanged = true;
        return withProtectionAnnotations(part, restorationsToAnnotations(field.value, restorations));
      }
      return part;
    });

    if (!partsChanged) return message;
    changed = true;
    return { ...message, parts: nextParts as UIMessage["parts"] };
  });

  pruneStore(store, livePositions);

  const restoreHighlightsAvailable = displayMessages.some((message) => {
    const direction = message.role === "user" ? "redacted" : message.role === "assistant" ? "restored" : undefined;
    return !!direction && message.parts.some((part) => protectionAnnotationsFromPart(part, direction).length > 0);
  });

  return { displayMessages: changed ? displayMessages : messages, restoreHighlightsAvailable };
}

type TextKey = "content" | "text";

function textField(part: UIMessage["parts"][number]): { key: TextKey; value: string } | undefined {
  if (part.type !== "text") return undefined;
  const maybe = part as { content?: unknown; text?: unknown };
  if (typeof maybe.content === "string") return { key: "content", value: maybe.content };
  if (typeof maybe.text === "string") return { key: "text", value: maybe.text };
  return undefined;
}

function recordLive(live: Map<number, Set<number>>, position: number, partIndex: number): void {
  const parts = live.get(position) ?? new Set<number>();
  parts.add(partIndex);
  live.set(position, parts);
}

function setStore(
  store: RestoreHighlightStore,
  position: number,
  partIndex: number,
  restorations: RestoreHighlight[],
): void {
  // A completed marker sweep is authoritative; but a fully marker-free re-parse (nothing restored) must
  // not wipe a turn that legitimately had restorations earlier in the same stream, so keep the last
  // non-empty set for a position/part.
  if (restorations.length === 0 && (store.get(position)?.get(partIndex)?.length ?? 0) > 0) return;
  const parts = store.get(position) ?? new Map<number, RestoreHighlight[]>();
  parts.set(partIndex, restorations);
  store.set(position, parts);
}

function pruneStore(store: RestoreHighlightStore, live: Map<number, Set<number>>): void {
  for (const [position, parts] of store) {
    const liveParts = live.get(position);
    if (!liveParts) {
      store.delete(position);
      continue;
    }
    for (const partIndex of parts.keys()) if (!liveParts.has(partIndex)) parts.delete(partIndex);
    if (parts.size === 0) store.delete(position);
  }
}

function serializeStore(store: RestoreHighlightStore): SerializedStore {
  const out: SerializedStore = {};
  for (const [position, parts] of store) {
    const partsOut: Record<number, RestoreHighlight[]> = {};
    for (const [partIndex, restorations] of parts) partsOut[partIndex] = restorations;
    out[position] = partsOut;
  }
  return out;
}

function deserializeStore(serialized: SerializedStore | undefined): RestoreHighlightStore {
  const store: RestoreHighlightStore = new Map();
  if (!serialized) return store;
  for (const [position, parts] of Object.entries(serialized)) {
    const partMap = new Map<number, RestoreHighlight[]>();
    for (const [partIndex, restorations] of Object.entries(parts)) partMap.set(Number(partIndex), restorations);
    store.set(Number(position), partMap);
  }
  return store;
}
