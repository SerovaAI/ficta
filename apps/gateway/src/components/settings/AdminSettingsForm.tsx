import { useRouter } from "@tanstack/react-router";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MODELS } from "@/lib/models";
import {
  isProtectionReviewMode,
  PROTECTION_REVIEW_MODES,
  type ProtectionReviewMode,
  protectionReviewModeLabel,
} from "@/lib/protection-review-mode";
import { updateInstanceSettings } from "@/lib/storage/settings";
import {
  type InstanceSettings,
  isModelAllowed,
  modelKey,
  normalizeSuggestedPrompts,
  resolveSuggestedPrompts,
  SUGGESTED_PROMPTS_MAX,
} from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

type SaveStatus = "idle" | "saving" | "error";
type PromptDraft = { id: string; value: string };

const NAME_SAVE_DELAY_MS = 600;
const PROMPTS_SAVE_DELAY_MS = 600;

function checkedFromSettings(settings: InstanceSettings): Set<string> {
  return new Set(MODELS.filter((m) => isModelAllowed(settings, modelKey(m))).map(modelKey));
}

function allowedModelsFromChecked(checked: Set<string>): string[] {
  // All checked ⇒ store [] (no restriction, future-proof). Otherwise store the checked subset.
  return checked.size === MODELS.length ? [] : [...checked];
}

function promptsKey(prompts: string[]): string {
  return JSON.stringify(normalizeSuggestedPrompts(prompts));
}

function promptDraftsFromSettings(settings: InstanceSettings): PromptDraft[] {
  return resolveSuggestedPrompts(settings).map((value, index) => ({ id: `saved-${index}-${value}`, value }));
}

function promptDraftValues(drafts: PromptDraft[]): string[] {
  return drafts.map((draft) => draft.value);
}

function InlineStatus({ status, error }: { status: SaveStatus; error: string }) {
  if (status === "idle") return null;
  return (
    <p className={status === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
      {status === "saving" ? "Saving…" : error}
    </p>
  );
}

function refreshRouteData(router: ReturnType<typeof useRouter>) {
  void router.invalidate().catch((err) => {
    console.warn("Saved admin settings, but route data could not refresh.", err);
  });
}

/**
 * Instance-wide settings, editable by admins. Rows autosave like ChatGPT/Claude settings: text changes
 * debounce, checkbox changes save immediately, and there is no form-level Save button.
 */
export function AdminSettingsForm({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const [name, setName] = useState(settings.instanceName ?? "");
  const [checked, setChecked] = useState<Set<string>>(() => checkedFromSettings(settings));
  const [promptDrafts, setPromptDrafts] = useState<PromptDraft[]>(() => promptDraftsFromSettings(settings));
  const [nameStatus, setNameStatus] = useState<SaveStatus>("idle");
  const [modelsStatus, setModelsStatus] = useState<SaveStatus>("idle");
  const [promptsStatus, setPromptsStatus] = useState<SaveStatus>("idle");
  const [reviewStatus, setReviewStatus] = useState<SaveStatus>("idle");
  const [reviewMinimum, setReviewMinimumState] = useState<ProtectionReviewMode>(
    settings.protectionReviewMinimum ?? "off",
  );
  const [modelsError, setModelsError] = useState("Couldn't save model availability.");
  const [promptsError, setPromptsError] = useState("Couldn't save suggested prompts.");
  const savedName = useRef(settings.instanceName ?? "");
  const savedPromptsKey = useRef(promptsKey(resolveSuggestedPrompts(settings)));
  const skipPromptDebounceKey = useRef<string | undefined>(undefined);
  const nextPromptId = useRef(0);
  const nameSeq = useRef(0);
  const modelsSeq = useRef(0);
  const promptsSeq = useRef(0);
  const reviewSavePending = useRef(false);

  useEffect(() => {
    const next = settings.instanceName ?? "";
    savedName.current = next;
    setName(next);
  }, [settings.instanceName]);

  useEffect(() => {
    setChecked(checkedFromSettings(settings));
  }, [settings]);

  useEffect(() => {
    setReviewMinimumState(settings.protectionReviewMinimum ?? "off");
  }, [settings.protectionReviewMinimum]);

  useEffect(() => {
    const next = promptDraftsFromSettings(settings);
    savedPromptsKey.current = promptsKey(promptDraftValues(next));
    skipPromptDebounceKey.current = undefined;
    setPromptDrafts(next);
  }, [settings]);

  const savePrompts = useCallback(
    async (next: string[], seq = promptsSeq.current + 1) => {
      promptsSeq.current = seq;
      setPromptsStatus("saving");
      setPromptsError("Couldn't save suggested prompts.");
      const normalized = normalizeSuggestedPrompts(next);

      try {
        await updateInstanceSettings({ data: { suggestedPrompts: normalized } });
        savedPromptsKey.current = JSON.stringify(normalized);
        skipPromptDebounceKey.current = undefined;
        refreshRouteData(router);
        if (promptsSeq.current === seq) setPromptsStatus("idle");
      } catch {
        if (promptsSeq.current === seq) setPromptsStatus("error");
      }
    },
    [router],
  );

  useEffect(() => {
    const nextName = name.trim();
    if (nextName === savedName.current) {
      setNameStatus("idle");
      return;
    }

    const seq = nameSeq.current + 1;
    nameSeq.current = seq;
    setNameStatus("saving");

    const timeout = window.setTimeout(async () => {
      try {
        const updated = await updateInstanceSettings({ data: { instanceName: name } });
        savedName.current = updated.instanceName ?? "";
        refreshRouteData(router);
        if (nameSeq.current === seq) setNameStatus("idle");
      } catch {
        if (nameSeq.current === seq) setNameStatus("error");
      }
    }, NAME_SAVE_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [name, router]);

  useEffect(() => {
    const next = promptDraftValues(promptDrafts);
    const nextKey = promptsKey(next);
    if (nextKey === savedPromptsKey.current) {
      setPromptsStatus("idle");
      return;
    }
    if (nextKey === skipPromptDebounceKey.current) return;

    const seq = promptsSeq.current + 1;
    promptsSeq.current = seq;
    setPromptsStatus("saving");

    const timeout = window.setTimeout(async () => {
      await savePrompts(next, seq);
    }, PROMPTS_SAVE_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [promptDrafts, savePrompts]);

  const saveModels = async (next: Set<string>, previous: Set<string>) => {
    const seq = modelsSeq.current + 1;
    modelsSeq.current = seq;
    setModelsStatus("saving");
    setModelsError("Couldn't save model availability.");

    try {
      await updateInstanceSettings({ data: { allowedModels: allowedModelsFromChecked(next) } });
      refreshRouteData(router);
      if (modelsSeq.current === seq) setModelsStatus("idle");
    } catch {
      if (modelsSeq.current === seq) {
        setChecked(previous);
        setModelsStatus("error");
      }
    }
  };

  const setReviewMinimum = async (minimum: ProtectionReviewMode) => {
    if (reviewSavePending.current || minimum === reviewMinimum) return;
    const previous = reviewMinimum;
    reviewSavePending.current = true;
    setReviewMinimumState(minimum);
    setReviewStatus("saving");
    try {
      await updateInstanceSettings({ data: { protectionReviewMinimum: minimum } });
      refreshRouteData(router);
      setReviewStatus("idle");
    } catch {
      setReviewMinimumState(previous);
      setReviewStatus("error");
    } finally {
      reviewSavePending.current = false;
    }
  };

  const savePromptsImmediately = (next: string[]) => {
    const seq = promptsSeq.current + 1;
    skipPromptDebounceKey.current = promptsKey(next);
    void savePrompts(next, seq);
  };

  const toggle = (key: string, on: boolean) => {
    if (!on && checked.has(key) && checked.size <= 1) {
      setModelsError("Select at least one model.");
      setModelsStatus("error");
      return;
    }

    const next = new Set(checked);
    if (on) next.add(key);
    else next.delete(key);
    if (next.size === checked.size && next.has(key) === checked.has(key)) return;

    const previous = checked;
    setChecked(next);
    void saveModels(next, previous);
  };

  const editPrompt = (index: number, value: string) => {
    setPromptDrafts((current) => current.map((prompt, i) => (i === index ? { ...prompt, value } : prompt)));
  };

  const addPrompt = () => {
    if (promptDrafts.length >= SUGGESTED_PROMPTS_MAX) return;
    setPromptDrafts((current) => [...current, { id: `new-${nextPromptId.current++}`, value: "" }]);
  };

  const deletePrompt = (index: number) => {
    const nextDrafts = promptDrafts.filter((_, i) => i !== index);
    const next = promptDraftValues(nextDrafts);
    setPromptDrafts(nextDrafts);
    savePromptsImmediately(next);
  };

  return (
    <section>
      <SettingRow label="Instance name" htmlFor="instance-name" description="Shown in the sidebar header.">
        <div className="space-y-1">
          <Input
            id="instance-name"
            value={name}
            placeholder="ficta"
            className="w-48"
            onChange={(e) => setName(e.target.value)}
          />
          <InlineStatus status={nameStatus} error="Couldn't save instance name." />
        </div>
      </SettingRow>

      <SettingRow label="Available models" description="Only checked models can be selected in chat.">
        <div className="space-y-2">
          {MODELS.map((m) => {
            const key = modelKey(m);
            const id = `model-${key}`;
            return (
              <label
                key={key}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2.5 text-sm [@media(pointer:coarse)]:min-h-11"
              >
                <Checkbox id={id} checked={checked.has(key)} onCheckedChange={(state) => toggle(key, state === true)} />
                <span className="font-medium">{m.label}</span>
                <span className="text-muted-foreground">{m.sublabel}</span>
              </label>
            );
          })}
          <InlineStatus status={modelsStatus} error={modelsError} />
        </div>
      </SettingRow>

      <SettingRow
        label="Protection review"
        description="Set the least protective review mode users may choose. Each chat starts in Adaptive."
      >
        <div className="space-y-1">
          <ReviewMinimumPicker
            value={reviewMinimum}
            disabled={reviewStatus === "saving"}
            onChange={(mode) => void setReviewMinimum(mode)}
          />
          <InlineStatus status={reviewStatus} error="Couldn't save protection review settings." />
        </div>
      </SettingRow>

      <SettingRow label="Suggested prompts" description="Shown as quick-start buttons on a new empty chat.">
        <div className="w-full max-w-md space-y-2">
          {promptDrafts.map((prompt, index) => (
            <div key={prompt.id} className="flex items-center gap-2">
              <Input
                value={prompt.value}
                placeholder="Ask the assistant to..."
                className="min-w-0"
                onChange={(e) => editPrompt(index, e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => deletePrompt(index)}
              >
                <Trash2 className="size-4" aria-hidden />
                <span className="sr-only">Delete suggested prompt</span>
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={promptDrafts.length >= SUGGESTED_PROMPTS_MAX}
              onClick={addPrompt}
            >
              <Plus className="size-4" aria-hidden />
              Add prompt
            </Button>
            <InlineStatus status={promptsStatus} error={promptsError} />
          </div>
        </div>
      </SettingRow>
    </section>
  );
}

function ReviewMinimumPicker({
  value,
  disabled,
  onChange,
}: {
  value: ProtectionReviewMode;
  disabled?: boolean;
  onChange: (mode: ProtectionReviewMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={disabled}>
          <span className="font-medium">{protectionReviewModeLabel(value)}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(mode) => {
            if (isProtectionReviewMode(mode)) onChange(mode);
          }}
        >
          {PROTECTION_REVIEW_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} disabled={disabled} className="items-start py-2">
              <span>
                <span className="block font-medium">{protectionReviewModeLabel(mode)}</span>
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                  {minimumModeDescription(mode)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function minimumModeDescription(mode: ProtectionReviewMode): string {
  if (mode === "off") return "Users may choose any review mode.";
  if (mode === "adaptive") return "Every send must be analyzed; findings open review.";
  return "Every send must open review before continuing.";
}
