import { describe, expect, it } from "vitest";
import { type BodyLeaf, redactableBodyLeaves, visitBodyLeaves } from "../src/engine/vault.js";

describe("visitBodyLeaves", () => {
  it("visits keys and values once in deterministic structural order with paths", () => {
    const parsed = {
      messages: [{ role: "user", content: "hello" }],
      metadata: { label: "matter" },
      count: 3,
    };
    const leaves: BodyLeaf[] = [];
    const mapped = visitBodyLeaves(parsed, (leaf) => {
      leaves.push(leaf);
    });

    expect(leaves).toEqual([
      { index: 0, kind: "key", path: ["messages"], text: "messages" },
      { index: 1, kind: "key", path: ["messages", 0, "role"], text: "role" },
      { index: 2, kind: "value", path: ["messages", 0, "role"], text: "user" },
      { index: 3, kind: "key", path: ["messages", 0, "content"], text: "content" },
      { index: 4, kind: "value", path: ["messages", 0, "content"], text: "hello" },
      { index: 5, kind: "key", path: ["metadata"], text: "metadata" },
      { index: 6, kind: "key", path: ["metadata", "label"], text: "label" },
      { index: 7, kind: "value", path: ["metadata", "label"], text: "matter" },
      { index: 8, kind: "key", path: ["count"], text: "count" },
    ]);
    expect(mapped).toEqual(parsed);
  });

  it("rewrites keys and values through the same indices without changing primitives", () => {
    const parsed = { secret: ["alpha", 42, true, null] };
    const mapped = visitBodyLeaves(parsed, (leaf) => `[${leaf.index}:${leaf.kind}:${leaf.text}]`);
    expect(mapped).toEqual({ "[0:key:secret]": ["[1:value:alpha]", 42, true, null] });
  });

  it("represents a non-JSON body as one raw leaf", () => {
    const leaves: BodyLeaf[] = [];
    const mapped = visitBodyLeaves(
      "plain body",
      (leaf) => {
        leaves.push(leaf);
        return leaf.text.toUpperCase();
      },
      "raw",
    );
    expect(leaves).toEqual([{ index: 0, kind: "raw", path: [], text: "plain body" }]);
    expect(mapped).toBe("PLAIN BODY");
    expect(redactableBodyLeaves("plain body")).toEqual(["plain body"]);
  });
});
