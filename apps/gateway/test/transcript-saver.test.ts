import { describe, expect, it, vi } from "vitest";
import { createTranscriptSaver } from "@/lib/storage/transcript-saver";

describe("transcript save queue", () => {
  it("saves a submitted turn before its stopped partial response, using the acknowledged revision", async () => {
    let release!: (revision: number) => void;
    const save = vi
      .fn<(snapshot: string[], revision: number) => Promise<number>>()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(9);
    const enqueue = createTranscriptSaver(7, save);
    const submitted = enqueue(["question"]);
    const partial = ["question", "partial answer"];
    const stopped = enqueue(partial);
    partial[1] = "later mutation";
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, ["question"], 7);
    release(8);
    await Promise.all([submitted, stopped]);
    expect(save).toHaveBeenNthCalledWith(2, ["question", "partial answer"], 8);
  });

  it("does not submit later snapshots after a failed or unacknowledged save", async () => {
    const save = vi.fn().mockRejectedValue(new Error("connection lost"));
    const enqueue = createTranscriptSaver(3, save);
    const first = enqueue(["question"]);
    const second = enqueue(["question", "partial"]);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(enqueue(["another turn"])).rejects.toThrow("connection lost");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
