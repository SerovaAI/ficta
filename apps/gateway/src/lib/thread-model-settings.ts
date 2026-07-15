import {
  DEFAULT_REASONING_EFFORT,
  MODELS,
  type ModelChoice,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "@/lib/models";
import {
  type InstanceSettings,
  isModelAllowed,
  modelKey,
  type ThreadModelSettings,
  type UserSettings,
} from "@/lib/storage/types";

export interface ResolvedThreadModelSettings {
  choice: ModelChoice;
  reasoningEffort: ReasoningEffort;
}

/** Resolve stored chat controls against the current catalog and workspace allow-list. */
export function resolveThreadModelSettings(
  userSettings: UserSettings | undefined,
  instance: InstanceSettings,
  saved: ThreadModelSettings | undefined,
): ResolvedThreadModelSettings {
  const allowed = MODELS.filter((candidate) => isModelAllowed(instance, modelKey(candidate)));
  const savedChoice = saved
    ? allowed.find((candidate) => candidate.provider === saved.provider && candidate.model === saved.model)
    : undefined;
  const defaultModel = userSettings?.defaultModel;
  const defaultChoice = allowed.find(
    (candidate) => candidate.provider === defaultModel?.provider && candidate.model === defaultModel?.model,
  );
  const choice = savedChoice ?? defaultChoice ?? allowed[0] ?? MODELS[0];
  const preferredEffort =
    savedChoice && saved ? saved.reasoningEffort : (userSettings?.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT);
  return { choice, reasoningEffort: normalizeReasoningEffort(choice, preferredEffort) };
}

export function toThreadModelSettings(choice: ModelChoice, reasoningEffort: ReasoningEffort): ThreadModelSettings {
  return { provider: choice.provider, model: choice.model, reasoningEffort };
}
