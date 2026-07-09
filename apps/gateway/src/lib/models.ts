export type Provider = "openai" | "anthropic";

export const PROVIDERS: readonly Provider[] = ["openai", "anthropic"];

/**
 * Any model / bring-your-own-key. The selected provider+model is forwarded to /api/chat, which builds
 * the matching TanStack AI adapter — every call still flows through the ficta proxy (see api/chat.ts).
 * Add entries here; nothing else needs to change.
 */
export const MODELS = [
  { provider: "openai", model: "gpt-5-mini", label: "OpenAI", sublabel: "gpt-5-mini" },
  { provider: "openai", model: "gpt-5", label: "OpenAI", sublabel: "gpt-5" },
  { provider: "openai", model: "gpt-5-nano", label: "OpenAI", sublabel: "gpt-5-nano" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Anthropic", sublabel: "claude-sonnet-4-6" },
] as const satisfies readonly { provider: Provider; model: string; label: string; sublabel: string }[];

export type ModelChoice = (typeof MODELS)[number];

export const REASONING_EFFORTS = [
  { value: "none", label: "Instant" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]["value"];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

const REASONING_EFFORT_VALUES = new Set(REASONING_EFFORTS.map((effort) => effort.value));

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES.has(value as ReasoningEffort);
}
