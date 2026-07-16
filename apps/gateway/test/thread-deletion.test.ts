import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelThreadDeletion,
  clearThreadDeletionNotice,
  flushThreadDeletion,
  getHiddenThreadDeletionIds,
  getThreadDeletionNotice,
  scheduleThreadDeletion,
  THREAD_DELETION_UNDO_DELAY_MS,
  threadDeletionDisclosure,
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

  afterEach(async () => {
    flushThreadDeletion();
    await settlePromises();
    clearThreadDeletionNotice();
    vi.useRealTimers();
  });

  it("publishes a pending undo notice and hides the thread when metadata is provided", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true, recoveryDays: 30 },
    });

    const notice = getThreadDeletionNotice();
    expect(notice).toMatchObject({
      kind: "pending",
      id: "thread-1",
      title: "Deleted chat",
      previous: previousThreads,
      wasActive: true,
      recoveryDays: 30,
    });
    expect(notice?.kind === "pending" ? notice.expiresAt : 0).toBeGreaterThan(Date.now());
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);
  });

  it("does not promise permanent deletion when recovery is disabled — other copies may persist", () => {
    expect(threadDeletionDisclosure()).toEqual({ headline: "Deleted" });
  });

  it("discloses history removal and the recovery window when enabled", () => {
    expect(threadDeletionDisclosure(30)).toEqual({
      headline: "Removed from history",
      detail: "Records can recover it for 30 days.",
    });
  });

  it("commits a scheduled deletion after the undo window", async () => {
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
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);

    await settlePromises();
    expect(getHiddenThreadDeletionIds()).toEqual([]);
  });

  it("cancels a pending deletion for the matching thread", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    expect(cancelThreadDeletion("thread-2")).toBe(false);
    expect(getThreadDeletionNotice()).toMatchObject({ kind: "pending", id: "thread-1" });
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);
    expect(cancelThreadDeletion("thread-1")).toBe(true);
    expect(getThreadDeletionNotice()).toBeNull();
    expect(getHiddenThreadDeletionIds()).toEqual([]);

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps an expired deletion hidden until its async commit settles", async () => {
    let resolveCommit: () => void = () => undefined;
    const commit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve;
        }),
    );

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(getThreadDeletionNotice()).toBeNull();
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);

    resolveCommit();
    await settlePromises();
    expect(getHiddenThreadDeletionIds()).toEqual([]);
  });

  it("removes a hidden deletion id after a rejected commit settles", async () => {
    const commit = vi.fn(() => Promise.reject(new Error("delete failed")));

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);

    await settlePromises();
    expect(getHiddenThreadDeletionIds()).toEqual([]);
  });

  it("flushes the previous deletion when another deletion is scheduled", async () => {
    let resolveFirstCommit: () => void = () => undefined;
    const firstCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstCommit = resolve;
        }),
    );
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
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1", "thread-2"]);

    resolveFirstCommit();
    await settlePromises();
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-2"]);

    expect(cancelThreadDeletion("thread-2")).toBe(true);
    expect(getHiddenThreadDeletionIds()).toEqual([]);
    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(secondCommit).not.toHaveBeenCalled();
  });

  it("flushes a pending deletion and clears its notice", async () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit, {
      notice: { title: "Deleted chat", previous: previousThreads, wasActive: true },
    });

    flushThreadDeletion();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(getThreadDeletionNotice()).toBeNull();
    expect(getHiddenThreadDeletionIds()).toEqual(["thread-1"]);

    await settlePromises();
    expect(getHiddenThreadDeletionIds()).toEqual([]);
  });
});

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
