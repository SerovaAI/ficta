import { describe, expect, it } from "vitest";
import { chatErrorMessage } from "@/lib/chat-error-copy";

const FRIENDLY_UPSTREAM_MESSAGE =
  "The model service couldn’t be reached. Try again, or contact your admin if this continues.";

describe("chat error copy", () => {
  it("translates OpenAI's direct Ficta upstream error", () => {
    const rawEvent = { type: "ficta_upstream_error", message: "TypeError: fetch failed" };
    const error = Object.assign(new Error("502 TypeError: fetch failed"), { rawEvent });

    expect(chatErrorMessage(error)).toBe(FRIENDLY_UPSTREAM_MESSAGE);
    expect(error.message).toBe("502 TypeError: fetch failed");
    expect(error.rawEvent).toBe(rawEvent);
  });

  it("translates Anthropic's nested Ficta upstream error", () => {
    const error = Object.assign(new Error('502 {"error":{"type":"ficta_upstream_error"}}'), {
      rawEvent: { error: { type: "ficta_upstream_error", message: "TypeError: fetch failed" } },
    });

    expect(chatErrorMessage(error)).toBe(FRIENDLY_UPSTREAM_MESSAGE);
  });

  it("preserves unrelated structured provider errors", () => {
    const error = Object.assign(new Error("Rate limit exceeded"), {
      rawEvent: { type: "rate_limit_error", message: "Too many requests" },
    });

    expect(chatErrorMessage(error)).toBe("Rate limit exceeded");
  });

  it("preserves unstructured errors", () => {
    expect(chatErrorMessage(new Error("Connection closed unexpectedly"))).toBe("Connection closed unexpectedly");
  });
});
