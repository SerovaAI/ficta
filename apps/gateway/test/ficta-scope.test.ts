import { describe, expect, it } from "vitest";
import { fictaScopeFor } from "@/lib/ficta-scope.server";

describe("fictaScopeFor", () => {
  it("isolates the same thread id by authenticated user and workspace", () => {
    const owner = fictaScopeFor("org-a", "alice", "thread-1");
    expect(fictaScopeFor("org-a", "alice", "thread-1")).toBe(owner);
    expect(fictaScopeFor("org-a", "mallory", "thread-1")).not.toBe(owner);
    expect(fictaScopeFor("org-b", "alice", "thread-1")).not.toBe(owner);
    expect(owner).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});
