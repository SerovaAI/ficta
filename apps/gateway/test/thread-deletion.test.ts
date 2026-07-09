import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelThreadDeletion,
  clearThreadDeletionNotice,
  flushThreadDeletion,
  getThreadDeletionNotice,
  scheduleThreadDeletion,
  THREAD_DELETION_UNDO_DELAY_MS,
} from "../src/lib/storage/threadDeletion";
import type { ThreadSummary } from "../src/lib/storage/types";

const previousThreads: ThreadSummary[] = [
  {
    id: "thread-1",
    title: "Deleted chat",
    traceEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("thread deletion scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    flushThreadDeletion();
    clearThreadDeletionNotice();
    vi.useRealTimers();
  });

  it("publishes a pending undo notice when metadata is provided", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    const notice = getThreadDeletionNotice();
    expect(notice).toMatchObject({
      kind: "pending",
      id: "thread-1",
      title: "Deleted chat",
      previous: previousThreads,
      wasActive: true,
    });
    expect(notice?.kind === "pending" ? notice.expiresAt : 0).toBeGreaterThan(Date.now());
  });

  it("commits a scheduled deletion after the undo window", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    expect(getThreadDeletionNotice()).toMatchObject({ kind: "pending", id: "thread-1" });

    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(getThreadDeletionNotice()).toBeNull();
  });

  it("cancels a pending deletion for the matching thread", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    expect(cancelThreadDeletion("thread-2")).toBe(false);
    expect(getThreadDeletionNotice()).toMatchObject({ kind: "pending", id: "thread-1" });
    expect(cancelThreadDeletion("thread-1")).toBe(true);
    expect(getThreadDeletionNotice()).toBeNull();

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(commit).not.toHaveBeenCalled();
  });

  it("flushes the previous deletion when another deletion is scheduled", () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();

    scheduleThreadDeletion("thread-1", firstCommit, {
      notice: { title: "First chat", previous: previousThreads, wasActive: false },
    });
    scheduleThreadDeletion("thread-2", secondCommit, {
      notice: { title: "Second chat", previous: previousThreads, wasActive: false },
    });

    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(secondCommit).not.toHaveBeenCalled();
    expect(getThreadDeletionNotice()).toMatchObject({ kind: "pending", id: "thread-2", title: "Second chat" });

    expect(cancelThreadDeletion("thread-2")).toBe(true);
    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(secondCommit).not.toHaveBeenCalled();
  });

  it("flushes a pending deletion and clears its notice", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    flushThreadDeletion();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(getThreadDeletionNotice()).toBeNull();
  });
});
