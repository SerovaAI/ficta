import { describe, expect, it } from "vitest";
import { shouldClearThreadTrace } from "@/lib/trace-capture";

describe("thread trace dual opt-in", () => {
  it("clears an opted-in chat when a known runtime grant is disabled", () => {
    expect(shouldClearThreadTrace(true, { loaded: true, known: true, rawBodies: false }, true)).toBe(true);
  });

  it("does not clear on loading, proxy errors, non-admin views, or an active grant", () => {
    expect(shouldClearThreadTrace(true, { loaded: false, known: false, rawBodies: false }, true)).toBe(false);
    expect(shouldClearThreadTrace(true, { loaded: true, known: false, rawBodies: false }, true)).toBe(false);
    expect(shouldClearThreadTrace(false, { loaded: true, known: true, rawBodies: false }, true)).toBe(false);
    expect(shouldClearThreadTrace(true, { loaded: true, known: true, rawBodies: true }, true)).toBe(false);
    expect(shouldClearThreadTrace(true, { loaded: true, known: true, rawBodies: false }, false)).toBe(false);
  });
});
