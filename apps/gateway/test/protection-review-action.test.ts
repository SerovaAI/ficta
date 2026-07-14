import { describe, expect, it } from "vitest";
import { runProtectionReviewAction } from "../src/lib/protection-review-action";

describe("runProtectionReviewAction", () => {
  it("protects without suggesting for the chat-only action", async () => {
    const calls: string[] = [];
    const result = await runProtectionReviewAction({
      destination: "chat",
      protect: async () => {
        calls.push("protect");
        return "preview";
      },
      suggest: async () => {
        calls.push("suggest");
        return [];
      },
    });

    expect(result).toEqual({ protection: "preview", suggestion: "not-requested" });
    expect(calls).toEqual(["protect"]);
  });

  it.each([
    [1, "saved"],
    [0, "existing"],
  ] as const)("protects before reporting a workspace suggestion result", async (saved, suggestion) => {
    const calls: string[] = [];
    const result = await runProtectionReviewAction({
      destination: "chat-and-workspace",
      protect: async () => {
        calls.push("protect");
        return "preview";
      },
      suggest: async () => {
        calls.push("suggest");
        return Array.from({ length: saved });
      },
    });

    expect(result).toEqual({ protection: "preview", suggestion });
    expect(calls).toEqual(["protect", "suggest"]);
  });

  it("preserves successful chat protection when workspace suggestion fails", async () => {
    const result = await runProtectionReviewAction({
      destination: "chat-and-workspace",
      protect: async () => "preview",
      suggest: async () => {
        throw new Error("registry unavailable");
      },
    });

    expect(result).toEqual({ protection: "preview", suggestion: "failed" });
  });

  it("does not suggest when chat protection fails", async () => {
    let suggested = false;
    await expect(
      runProtectionReviewAction({
        destination: "chat-and-workspace",
        protect: async () => {
          throw new Error("preview failed");
        },
        suggest: async () => {
          suggested = true;
          return [{}];
        },
      }),
    ).rejects.toThrow("preview failed");
    expect(suggested).toBe(false);
  });
});
