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

let pending: PendingDeletion | null = null;

export const THREAD_DELETION_UNDO_DELAY_MS = 5000;

/** Schedule `commit` to run after `delayMs`. Any earlier pending deletion is flushed immediately first. */
export function scheduleThreadDeletion(
  id: string,
  commit: () => Promise<void> | void,
  delayMs = THREAD_DELETION_UNDO_DELAY_MS,
): void {
  flushThreadDeletion();
  const timer = setTimeout(() => {
    pending = null;
    void commit();
  }, delayMs);
  pending = { id, timer, commit };
}

/** Cancel a pending deletion (Undo). Returns false if it already committed or was never pending. */
export function cancelThreadDeletion(id: string): boolean {
  if (pending?.id !== id) return false;
  clearTimeout(pending.timer);
  pending = null;
  return true;
}

/** Commit any pending deletion now (second delete, page unload). */
export function flushThreadDeletion(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { commit } = pending;
  pending = null;
  void commit();
}

// Best-effort: don't let a queued deletion evaporate if the tab closes mid-window.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushThreadDeletion);
}
