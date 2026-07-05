import { useRouter } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  MODELS,
  type ModelChoice,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@/lib/models";
import { updateUserSettings } from "@/lib/storage/settings";
import type { UserSettings } from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

/** Map stored settings to a concrete MODELS entry; fall back to the first model if unset or stale. */
function resolveChoice(settings: UserSettings): ModelChoice {
  const dm = settings.defaultModel;
  return MODELS.find((m) => m.provider === dm?.provider && m.model === dm?.model) ?? MODELS[0];
}

function resolveReasoning(settings: UserSettings): ReasoningEffort {
  return isReasoningEffort(settings.defaultReasoningEffort)
    ? settings.defaultReasoningEffort
    : DEFAULT_REASONING_EFFORT;
}

function InlineStatus({ status, error }: { status: "idle" | "saving" | "error"; error: string }) {
  if (status === "idle") return null;
  return (
    <p className={status === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
      {status === "saving" ? "Saving…" : error}
    </p>
  );
}

export function UserSettingsForm({ settings }: { settings: UserSettings }) {
  const router = useRouter();
  const initial = resolveChoice(settings);
  const initialReasoning = resolveReasoning(settings);
  const [choice, setChoice] = useState<ModelChoice>(initial);
  const [reasoning, setReasoning] = useState<ReasoningEffort>(initialReasoning);
  const [modelStatus, setModelStatus] = useState<"idle" | "saving" | "error">("idle");
  const [reasoningStatus, setReasoningStatus] = useState<"idle" | "saving" | "error">("idle");
  const modelSaveSeq = useRef(0);
  const reasoningSaveSeq = useRef(0);

  const choose = async (next: ModelChoice) => {
    if (next.provider === choice.provider && next.model === choice.model) return;

    const previous = choice;
    const seq = modelSaveSeq.current + 1;
    modelSaveSeq.current = seq;
    setChoice(next);
    setModelStatus("saving");

    try {
      await updateUserSettings({ data: { defaultModel: { provider: next.provider, model: next.model } } });
      // Refresh router loaders/context so a re-open of settings reflects the saved value.
      await router.invalidate();
      if (modelSaveSeq.current === seq) setModelStatus("idle");
    } catch {
      if (modelSaveSeq.current === seq) {
        setChoice(previous);
        setModelStatus("error");
      }
    }
  };

  const chooseReasoning = async (next: ReasoningEffort) => {
    if (next === reasoning) return;

    const previous = reasoning;
    const seq = reasoningSaveSeq.current + 1;
    reasoningSaveSeq.current = seq;
    setReasoning(next);
    setReasoningStatus("saving");

    try {
      await updateUserSettings({ data: { defaultReasoningEffort: next } });
      await router.invalidate();
      if (reasoningSaveSeq.current === seq) setReasoningStatus("idle");
    } catch {
      if (reasoningSaveSeq.current === seq) {
        setReasoning(previous);
        setReasoningStatus("error");
      }
    }
  };

  return (
    <section className="space-y-1">
      <SettingRow label="Default model" description="Pre-selected when you start a new chat.">
        <div className="space-y-1">
          <ModelPicker value={choice} onChange={choose} />
          <InlineStatus status={modelStatus} error="Couldn't save default model." />
        </div>
      </SettingRow>
      <SettingRow label="Default reasoning" description="Pre-selected for OpenAI models in the composer.">
        <div className="space-y-1">
          <ReasoningPicker value={reasoning} onChange={chooseReasoning} />
          <InlineStatus status={reasoningStatus} error="Couldn't save default reasoning." />
        </div>
      </SettingRow>
    </section>
  );
}

function ReasoningPicker({ value, onChange }: { value: ReasoningEffort; onChange: (value: ReasoningEffort) => void }) {
  const label = REASONING_EFFORTS.find((effort) => effort.value === value)?.label ?? "Medium";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <span className="font-medium">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (isReasoningEffort(next)) onChange(next);
          }}
        >
          {REASONING_EFFORTS.map((effort) => (
            <DropdownMenuRadioItem key={effort.value} value={effort.value}>
              {effort.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
