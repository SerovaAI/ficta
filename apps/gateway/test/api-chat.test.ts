import { describe, expect, it } from "vitest";
import { resolveChatTraceEnabled } from "@/routes/api/chat";

describe("resolveChatTraceEnabled", () => {
  it("uses persisted thread trace state when the thread already exists", () => {
    expect(resolveChatTraceEnabled({ storedTraceEnabled: true, requestedTraceEnabled: false, admin: true })).toBe(true);
    expect(resolveChatTraceEnabled({ storedTraceEnabled: false, requestedTraceEnabled: true, admin: true })).toBe(
      false,
    );
  });

  it("honors pending new-thread trace capture for admins only", () => {
    expect(resolveChatTraceEnabled({ storedTraceEnabled: undefined, requestedTraceEnabled: true, admin: true })).toBe(
      true,
    );
    expect(resolveChatTraceEnabled({ storedTraceEnabled: undefined, requestedTraceEnabled: true, admin: false })).toBe(
      false,
    );
  });
});
