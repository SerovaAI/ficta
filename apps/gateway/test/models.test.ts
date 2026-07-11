import { describe, expect, it } from "vitest";
import { MODELS, normalizeReasoningEffort, type ReasoningEffort, reasoningEffortsForModel } from "@/lib/models";
import { isModelAllowed, modelKey } from "@/lib/storage/types";

const model = (id: string) => {
  const choice = MODELS.find((candidate) => candidate.provider === "openai" && candidate.model === id);
  if (!choice) throw new Error(`missing test model ${id}`);
  return choice;
};

describe("model catalog", () => {
  it("keeps gpt-5-mini as the default and adds the full GPT-5.6 family", () => {
    expect(modelKey(MODELS[0])).toBe("openai/gpt-5-mini");
    expect(MODELS.slice(1, 4).map(modelKey)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);
  });

  it("exposes new models on unrestricted instances and honors explicit allow-lists", () => {
    const sol = modelKey(model("gpt-5.6-sol"));
    expect(isModelAllowed({}, sol)).toBe(true);
    expect(isModelAllowed({ allowedModels: [] }, sol)).toBe(true);
    expect(isModelAllowed({ allowedModels: ["openai/gpt-5"] }, sol)).toBe(false);
    expect(isModelAllowed({ allowedModels: [sol] }, sol)).toBe(true);
  });
});

describe("model reasoning efforts", () => {
  it("publishes the supported effort surface for each GPT generation", () => {
    expect(reasoningEffortsForModel(model("gpt-5"))).toEqual(["minimal", "low", "medium", "high"]);
    expect(reasoningEffortsForModel(model("gpt-5.6-sol"))).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it.each([
    ["gpt-5", "none", "minimal"],
    ["gpt-5-mini", "xhigh", "high"],
    ["gpt-5-nano", "max", "high"],
    ["gpt-5.6-sol", "minimal", "low"],
    ["gpt-5.6-terra", "minimal", "low"],
    ["gpt-5.6-luna", "minimal", "low"],
  ] as const)("clamps %s effort %s to %s", (modelId, effort, expected) => {
    expect(normalizeReasoningEffort(model(modelId), effort)).toBe(expected);
  });

  it.each([
    ["gpt-5", "minimal"],
    ["gpt-5-mini", "medium"],
    ["gpt-5-nano", "high"],
    ["gpt-5.6-sol", "none"],
    ["gpt-5.6-terra", "xhigh"],
    ["gpt-5.6-luna", "max"],
  ] as const)("preserves supported %s effort %s", (modelId, effort) => {
    expect(normalizeReasoningEffort(model(modelId), effort)).toBe(effort satisfies ReasoningEffort);
  });
});
