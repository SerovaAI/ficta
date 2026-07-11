import { describe, expect, it } from "vitest";
import { RuntimeTraceCapture } from "../src/runtime-trace-capture.js";

describe("RuntimeTraceCapture", () => {
  it("defaults off, renews its expiry, disables immediately, and expires lazily", () => {
    let now = Date.parse("2026-07-11T12:00:00.000Z");
    const capture = new RuntimeTraceCapture(1_000, () => now);

    expect(capture.state()).toEqual({ enabled: false, ttlSeconds: 1 });
    expect(capture.set(true)).toEqual({
      enabled: true,
      expiresAt: "2026-07-11T12:00:01.000Z",
      ttlSeconds: 1,
    });

    now += 500;
    expect(capture.set(true).expiresAt).toBe("2026-07-11T12:00:01.500Z");
    expect(capture.set(false)).toEqual({ enabled: false, ttlSeconds: 1 });

    capture.set(true);
    now += 1_000;
    expect(capture.enabled()).toBe(false);
    expect(capture.state()).toEqual({ enabled: false, ttlSeconds: 1 });
  });
});
