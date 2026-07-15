import { describe, expect, it } from "vitest";
import { MODELS } from "@/lib/models";
import type { ThreadModelSettings } from "@/lib/storage/types";
import { resolveThreadModelSettings, toThreadModelSettings } from "@/lib/thread-model-settings";

const saved = (model: string, reasoningEffort: ThreadModelSettings["reasoningEffort"]): ThreadModelSettings => ({
  provider: "openai",
  model,
  reasoningEffort,
});

describe("thread model settings", () => {
  it("prefers a saved allowed model and reasoning over user defaults", () => {
    const resolved = resolveThreadModelSettings(
      { defaultModel: { provider: "openai", model: "gpt-5-mini" }, defaultReasoningEffort: "minimal" },
      {},
      saved("gpt-5.6-sol", "xhigh"),
    );

    expect(toThreadModelSettings(resolved.choice, resolved.reasoningEffort)).toEqual(saved("gpt-5.6-sol", "xhigh"));
  });

  it("uses configured defaults for new and legacy chats", () => {
    const resolved = resolveThreadModelSettings(
      { defaultModel: { provider: "openai", model: "gpt-5" }, defaultReasoningEffort: "low" },
      {},
      undefined,
    );

    expect(resolved.choice.model).toBe("gpt-5");
    expect(resolved.reasoningEffort).toBe("low");
  });

  it("falls back to the configured allowed default without carrying saved reasoning", () => {
    const resolved = resolveThreadModelSettings(
      { defaultModel: { provider: "openai", model: "gpt-5" }, defaultReasoningEffort: "minimal" },
      { allowedModels: ["openai/gpt-5"] },
      saved("gpt-5.6-sol", "max"),
    );

    expect(resolved.choice.model).toBe("gpt-5");
    expect(resolved.reasoningEffort).toBe("minimal");
  });

  it("ignores stale models and normalizes reasoning for the resolved catalog model", () => {
    const stale = { provider: "openai", model: "retired-model", reasoningEffort: "max" } as ThreadModelSettings;
    const resolved = resolveThreadModelSettings(
      { defaultModel: { provider: "openai", model: "gpt-5" }, defaultReasoningEffort: "max" },
      {},
      stale,
    );

    expect(resolved.choice).toBe(MODELS.find((candidate) => candidate.model === "gpt-5"));
    expect(resolved.reasoningEffort).toBe("high");
  });
});
