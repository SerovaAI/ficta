import type { ThreadSummary } from "./types";

/**
 * Deferred thread deletion so the UI can offer a real Undo. The destructive server call is held for a
 * grace window instead of firing on click; Undo cancels it, and anything that ends the window early
 * (a second delete, a page unload) flushes it so the intent is never silently lost.
 *
 * State lives at module scope, not in a component, so it survives the sidebar remount that a
 * navigate-to-"/" (deleting the open thread) triggers within the grace window.
 */
type PendingDeletion = {
  id: string;
  timer: ReturnType<typeof setTimeout>;
  commit: () => Promise<void> | void;
};

export type ThreadDeletionNotice =
  | {
      kind: "pending";
      id: string;
      title: string;
      previous: ThreadSummary[] | undefined;
      wasActive: boolean;
      expiresAt: number;
    }
  | {
      kind: "error";
      message: string;
    };

type ThreadDeletionNoticeInput = {
  title: string;
  previous?: ThreadSummary[];
  wasActive?: boolean;
};

type ScheduleThreadDeletionOptions =
  | number
  | {
      delayMs?: number;
      notice?: ThreadDeletionNoticeInput;
    };

let pending: PendingDeletion | null = null;
let notice: ThreadDeletionNotice | null = null;
const listeners = new Set<() => void>();

export const THREAD_DELETION_UNDO_DELAY_MS = 5000;

export function getThreadDeletionNotice(): ThreadDeletionNotice | null {
  return notice;
}

export function subscribeThreadDeletionNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function showThreadDeletionError(message: string): void {
  setNotice({ kind: "error", message });
}

export function clearThreadDeletionNotice(): void {
  setNotice(null);
}

/** Schedule `commit` to run after `delayMs`. Any earlier pending deletion is flushed immediately first. */
export function scheduleThreadDeletion(
  id: string,
  commit: () => Promise<void> | void,
  options: ScheduleThreadDeletionOptions = THREAD_DELETION_UNDO_DELAY_MS,
): void {
  const delayMs = typeof options === "number" ? options : (options.delayMs ?? THREAD_DELETION_UNDO_DELAY_MS);
  const noticeInput = typeof options === "number" ? undefined : options.notice;
  flushThreadDeletion();
  const expiresAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    pending = null;
    setNotice(null);
    void commit();
  }, delayMs);
  pending = { id, timer, commit };
  setNotice(
    noticeInput
      ? {
          kind: "pending",
          id,
          title: noticeInput.title,
          previous: noticeInput.previous,
          wasActive: noticeInput.wasActive ?? false,
          expiresAt,
        }
      : null,
  );
}

/** Cancel a pending deletion (Undo). Returns false if it already committed or was never pending. */
export function cancelThreadDeletion(id: string): boolean {
  if (pending?.id !== id) return false;
  clearTimeout(pending.timer);
  pending = null;
  setNotice(null);
  return true;
}

/** Commit any pending deletion now (second delete, page unload). */
export function flushThreadDeletion(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { commit } = pending;
  pending = null;
  setNotice(null);
  void commit();
}

function setNotice(next: ThreadDeletionNotice | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

// Best-effort: don't let a queued deletion evaporate if the tab closes mid-window.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushThreadDeletion);
}
