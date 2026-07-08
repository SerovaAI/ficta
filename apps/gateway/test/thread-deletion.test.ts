import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelThreadDeletion,
  flushThreadDeletion,
  scheduleThreadDeletion,
  THREAD_DELETION_UNDO_DELAY_MS,
} from "../src/lib/storage/threadDeletion";

describe("thread deletion scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    flushThreadDeletion();
    vi.useRealTimers();
  });

  it("commits a scheduled deletion after the undo window", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit);

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS - 1);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending deletion for the matching thread", () => {
    const commit = vi.fn();

    scheduleThreadDeletion("thread-1", commit);

    expect(cancelThreadDeletion("thread-2")).toBe(false);
    expect(cancelThreadDeletion("thread-1")).toBe(true);

    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(commit).not.toHaveBeenCalled();
  });

  it("flushes the previous deletion when another deletion is scheduled", () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();

    scheduleThreadDeletion("thread-1", firstCommit);
    scheduleThreadDeletion("thread-2", secondCommit);

    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(secondCommit).not.toHaveBeenCalled();

    expect(cancelThreadDeletion("thread-2")).toBe(true);
    vi.advanceTimersByTime(THREAD_DELETION_UNDO_DELAY_MS);
    expect(secondCommit).not.toHaveBeenCalled();
  });
});
