import { AlertTriangle, ArrowUp, Check, ChevronDown, FileText, Loader2, Paperclip, Square, X } from "lucide-react";
import { Fragment, forwardRef, type ReactNode, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canSubmitComposerDraft } from "@/lib/composer-submit";
import { ATTACHMENT_ACCEPT, formatBytes, type TextAttachment } from "@/lib/file-attachments";
import {
  isReasoningEffort,
  MODELS,
  type ModelChoice,
  REASONING_EFFORTS,
  type ReasoningEffort,
  reasoningEffortsForModel,
} from "@/lib/models";
import { isModelAllowed, modelKey } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";

export type ComposerHandle = {
  focus: () => void;
  focusEnd: () => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSubmit,
    onStop,
    isLoading,
    isExtracting,
    disabledReason,
    model,
    onModelChange,
    reasoningEffort,
    onReasoningEffortChange,
    attachments,
    uploadWarning,
    autoFocus,
    onFilesSelected,
    onRemoveAttachment,
    onDismissUploadWarning,
    review,
    defaultModel,
    defaultReasoningEffort,
  },
  forwardedRef,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => ref.current?.focus(),
    focusEnd: () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    },
  }));

  // Auto-grow: reset then match content, capped so it scrolls past a few lines. `value` isn't read in
  // the body but must stay in deps so the height recomputes on every edit (including programmatic clears).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const canSend = canSubmitComposerDraft({
    value,
    attachmentCount: attachments.length,
    isLoading,
    isExtracting,
    disabledReason,
  });

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {uploadWarning && uploadWarning.length > 0 ? (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {uploadWarning.length === 1 ? (
              <p className="min-w-0 flex-1">{uploadWarning[0]}</p>
            ) : (
              <ul className="min-w-0 flex-1 list-disc space-y-0.5 pl-4">
                {uploadWarning.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="rounded-md p-0.5 text-amber-900/70 hover:bg-amber-100 hover:text-amber-950 [@media(pointer:coarse)]:p-2 dark:text-amber-100/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-50"
              onClick={onDismissUploadWarning}
              aria-label="Dismiss upload warning"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
                title={attachment.name}
              >
                <FileText className="size-3.5 shrink-0" aria-hidden />
                <span className="max-w-48 truncate">{attachment.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(pointer:coarse)]:size-11"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  disabled={Boolean(review)}
                  title={review ? "Return to editing to remove this attachment" : undefined}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {isExtracting ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span>Extracting text from your document…</span>
          </div>
        ) : null}

        {review ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">{review}</div>
        ) : (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-sm focus-within:ring-1 focus-within:ring-ring sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                if (files.length > 0) onFilesSelected(files);
                e.currentTarget.value = "";
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="col-start-1 row-start-1 size-8 rounded-lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || isExtracting}
              aria-label="Attach a file"
            >
              <Paperclip className="size-4" aria-hidden />
            </Button>
            <textarea
              ref={ref}
              value={value}
              rows={1}
              aria-label="Message"
              placeholder="Paste a document, attach a text file, or ask a question…"
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) onSubmit();
                }
              }}
              className="col-start-2 row-start-1 max-h-[200px] min-w-0 resize-none bg-transparent px-1.5 py-1 text-[0.95rem] leading-6 outline-none placeholder:text-muted-foreground"
            />
            <div className="col-span-3 row-start-2 flex min-w-0 items-center border-t border-border/70 pt-1 sm:contents">
              <ComposerModelControl
                model={model}
                onModelChange={onModelChange}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                defaultModel={defaultModel}
                defaultReasoningEffort={defaultReasoningEffort}
                disabled={isLoading || isExtracting}
              />
            </div>
            {isLoading ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="col-start-3 row-start-1 size-8 rounded-lg sm:col-start-4"
                onClick={onStop}
                aria-label="Stop"
              >
                <Square className="size-4 fill-current" aria-hidden />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="col-start-3 row-start-1 size-8 rounded-lg sm:col-start-4"
                onClick={onSubmit}
                disabled={!canSend}
                aria-label="Send"
              >
                <ArrowUp className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        )}
        {disabledReason ? <p className="mt-2 text-center text-xs text-muted-foreground">{disabledReason}</p> : null}
      </div>
    </div>
  );
});

type ComposerProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
  isExtracting?: boolean;
  /** When set, sending is blocked (protection unavailable/paused) and this explains why. */
  disabledReason?: string;
  model: ModelChoice;
  onModelChange: (choice: ModelChoice) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  attachments: TextAttachment[];
  uploadWarning?: string[];
  autoFocus?: boolean;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissUploadWarning: () => void;
  /** When present, replaces the editable row inside the same composer surface. */
  review?: ReactNode;
  defaultModel?: { provider: string; model: string };
  defaultReasoningEffort?: ReasoningEffort;
};

function ComposerModelControl({
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  defaultModel,
  defaultReasoningEffort,
}: {
  model: ModelChoice;
  onModelChange: (choice: ModelChoice) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  defaultModel?: { provider: string; model: string };
  defaultReasoningEffort?: ReasoningEffort;
}) {
  const instance = useInstanceSettings();
  const models = MODELS.filter((m) => isModelAllowed(instance, modelKey(m)));
  const reasoningEfforts = reasoningEffortsForModel(model);
  const selectedReasoning = REASONING_EFFORTS.find((effort) => effort.value === reasoningEffort);
  const reasoningDisabled = reasoningEfforts.length === 0;
  const reasoningLabel = selectedReasoning?.label ?? "Medium";
  const selectedModelKey = modelKey(model);
  const defaultModelKey = defaultModel ? modelKey(defaultModel) : undefined;
  const effectiveDefaultModelKey =
    defaultModelKey && models.some((candidate) => modelKey(candidate) === defaultModelKey)
      ? defaultModelKey
      : modelKey(models[0] ?? model);
  const providerGroups = [...new Set(models.map((candidate) => candidate.label))];
  const controlLabel = reasoningDisabled
    ? `Choose model and reasoning settings. Current model: ${model.sublabel}. Reasoning is available for OpenAI models only.`
    : `Choose model and reasoning settings. Current model: ${model.sublabel}. Current reasoning: ${reasoningLabel}.`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 max-w-full min-w-0 gap-1.5 rounded-lg px-2.5 sm:col-start-3 sm:row-start-1 sm:max-w-[14rem]"
          disabled={disabled}
          aria-label={controlLabel}
          title={model.sublabel}
        >
          <span className="min-w-0 truncate font-medium">{model.sublabel}</span>
          {!reasoningDisabled ? (
            <span className="shrink-0 text-muted-foreground text-xs">· {reasoningLabel}</span>
          ) : null}
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {providerGroups.map((provider, providerIndex) => (
          <Fragment key={provider}>
            {providerIndex > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{provider}</DropdownMenuLabel>
            {models
              .filter((candidate) => candidate.label === provider)
              .map((candidate) => {
                const candidateKey = modelKey(candidate);
                return (
                  <DropdownMenuItem
                    key={candidateKey}
                    onSelect={() => onModelChange(candidate)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{candidate.sublabel}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {candidateKey === effectiveDefaultModelKey ? (
                        <span className="text-muted-foreground text-xs">Default</span>
                      ) : null}
                      {candidateKey === selectedModelKey ? <Check className="size-4" aria-hidden /> : null}
                    </span>
                  </DropdownMenuItem>
                );
              })}
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        {reasoningDisabled ? (
          <DropdownMenuItem disabled className="flex items-center justify-between gap-2">
            <span>Reasoning</span>
            <span className="text-xs text-muted-foreground">OpenAI only</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="min-w-0 flex-1 truncate">Reasoning level</span>
              <span className="max-w-24 truncate text-muted-foreground">{reasoningLabel}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuRadioGroup
                value={reasoningEffort}
                onValueChange={(value) => {
                  if (isReasoningEffort(value) && reasoningEfforts.includes(value)) onReasoningEffortChange(value);
                }}
              >
                {REASONING_EFFORTS.filter((effort) => reasoningEfforts.includes(effort.value)).map((effort) => (
                  <DropdownMenuRadioItem key={effort.value} value={effort.value}>
                    <span className="min-w-0 flex-1">{effort.label}</span>
                    {effort.value === defaultReasoningEffort ? (
                      <span className="text-muted-foreground text-xs">Default</span>
                    ) : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
