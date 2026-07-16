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
      recoveryDays?: number;
    }
  | {
      kind: "error";
      message: string;
    };

type ThreadDeletionNoticeInput = {
  title: string;
  previous?: ThreadSummary[];
  wasActive?: boolean;
  recoveryDays?: number;
};

type ScheduleThreadDeletionOptions =
  | number
  | {
      delayMs?: number;
      notice?: ThreadDeletionNoticeInput;
    };

let pending: PendingDeletion | null = null;
let notice: ThreadDeletionNotice | null = null;
const hiddenThreadDeletionIds = new Set<string>();
let hiddenThreadDeletionIdsSnapshot: readonly string[] = [];
const listeners = new Set<() => void>();

export const THREAD_DELETION_UNDO_DELAY_MS = 5000;

export function threadDeletionDisclosure(recoveryDays?: number): { headline: string; detail?: string } {
  return recoveryDays
    ? { headline: "Removed from history", detail: `Records can recover it for ${recoveryDays} days.` }
    : { headline: "Permanently deleted" };
}

export function getThreadDeletionNotice(): ThreadDeletionNotice | null {
  return notice;
}

export function getHiddenThreadDeletionIds(): readonly string[] {
  return hiddenThreadDeletionIdsSnapshot;
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
  addHiddenThreadDeletionId(id);
  const expiresAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    pending = null;
    setNotice(null);
    runThreadDeletionCommit(id, commit);
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
          recoveryDays: noticeInput.recoveryDays,
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
  removeHiddenThreadDeletionId(id);
  return true;
}

/** Commit any pending deletion now (second delete, page unload). */
export function flushThreadDeletion(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { id, commit } = pending;
  pending = null;
  setNotice(null);
  runThreadDeletionCommit(id, commit);
}

function setNotice(next: ThreadDeletionNotice | null): void {
  notice = next;
  notifyListeners();
}

function addHiddenThreadDeletionId(id: string): void {
  if (hiddenThreadDeletionIds.has(id)) return;
  hiddenThreadDeletionIds.add(id);
  hiddenThreadDeletionIdsSnapshot = Array.from(hiddenThreadDeletionIds);
  notifyListeners();
}

function removeHiddenThreadDeletionId(id: string): void {
  if (!hiddenThreadDeletionIds.has(id)) return;
  hiddenThreadDeletionIds.delete(id);
  hiddenThreadDeletionIdsSnapshot = Array.from(hiddenThreadDeletionIds);
  notifyListeners();
}

function runThreadDeletionCommit(id: string, commit: () => Promise<void> | void): void {
  let result: Promise<void> | void;
  try {
    result = commit();
  } catch {
    removeHiddenThreadDeletionId(id);
    return;
  }
  void Promise.resolve(result)
    .catch(() => undefined)
    .finally(() => removeHiddenThreadDeletionId(id));
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

// Best-effort: don't let a queued deletion evaporate if the tab closes mid-window.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushThreadDeletion);
}
