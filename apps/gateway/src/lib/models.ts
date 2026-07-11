export type Provider = "openai" | "anthropic";

export const PROVIDERS: readonly Provider[] = ["openai", "anthropic"];

export const REASONING_EFFORTS = [
  { value: "none", label: "Instant" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]["value"];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

const LEGACY_GPT5_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
const GPT56_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Any model / bring-your-own-key. The selected provider+model is forwarded to /api/chat, which builds
 * the matching TanStack AI adapter — every call still flows through the ficta proxy (see api/chat.ts).
 * Add entries here; nothing else needs to change.
 */
export const MODELS = [
  {
    provider: "openai",
    model: "gpt-5-mini",
    label: "OpenAI",
    sublabel: "gpt-5-mini",
    reasoningEfforts: LEGACY_GPT5_REASONING_EFFORTS,
  },
  {
    provider: "openai",
    model: "gpt-5.6-sol",
    label: "OpenAI",
    sublabel: "gpt-5.6-sol",
    reasoningEfforts: GPT56_REASONING_EFFORTS,
  },
  {
    provider: "openai",
    model: "gpt-5.6-terra",
    label: "OpenAI",
    sublabel: "gpt-5.6-terra",
    reasoningEfforts: GPT56_REASONING_EFFORTS,
  },
  {
    provider: "openai",
    model: "gpt-5.6-luna",
    label: "OpenAI",
    sublabel: "gpt-5.6-luna",
    reasoningEfforts: GPT56_REASONING_EFFORTS,
  },
  {
    provider: "openai",
    model: "gpt-5",
    label: "OpenAI",
    sublabel: "gpt-5",
    reasoningEfforts: LEGACY_GPT5_REASONING_EFFORTS,
  },
  {
    provider: "openai",
    model: "gpt-5-nano",
    label: "OpenAI",
    sublabel: "gpt-5-nano",
    reasoningEfforts: LEGACY_GPT5_REASONING_EFFORTS,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Anthropic",
    sublabel: "claude-sonnet-4-6",
    reasoningEfforts: [],
  },
] as const satisfies readonly {
  provider: Provider;
  model: string;
  label: string;
  sublabel: string;
  reasoningEfforts: readonly ReasoningEffort[];
}[];

export type ModelChoice = (typeof MODELS)[number];

const REASONING_EFFORT_VALUES = new Set(REASONING_EFFORTS.map((effort) => effort.value));

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES.has(value as ReasoningEffort);
}

/** Supported effort values for a catalog model. Unknown OpenAI models retain the generic effort surface. */
export function reasoningEffortsForModel(model: { provider: string; model: string }): readonly ReasoningEffort[] {
  const choice = MODELS.find((candidate) => candidate.provider === model.provider && candidate.model === model.model);
  if (choice) return choice.reasoningEfforts;
  return model.provider === "openai" ? REASONING_EFFORTS.map((effort) => effort.value) : [];
}

/**
 * Preserve an effort when the model accepts it; otherwise clamp to the nearest compatible level.
 * Models without OpenAI reasoning controls retain the preference so it is available when switching back.
 */
export function normalizeReasoningEffort(
  model: { provider: string; model: string },
  effort: ReasoningEffort,
): ReasoningEffort {
  const supported = reasoningEffortsForModel(model);
  if (supported.length === 0 || supported.includes(effort)) return effort;

  if (effort === "none" && supported.includes("minimal")) return "minimal";
  if (effort === "minimal" && supported.includes("low")) return "low";
  if ((effort === "xhigh" || effort === "max") && supported.includes("high")) return "high";

  return supported.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : (supported[0] ?? DEFAULT_REASONING_EFFORT);
}
