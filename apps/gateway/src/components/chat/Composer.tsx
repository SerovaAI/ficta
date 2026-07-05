import { AlertTriangle, ArrowUp, Check, ChevronDown, FileText, Loader2, Paperclip, Square, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
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
import { ATTACHMENT_ACCEPT, formatBytes, type TextAttachment } from "@/lib/file-attachments";
import { MODELS, type ModelChoice, REASONING_EFFORTS, type ReasoningEffort } from "@/lib/models";
import { isModelAllowed, modelKey } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";

export type ComposerHandle = {
  focus: () => void;
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
  },
  forwardedRef,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => ref.current?.focus(),
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

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isLoading && !isExtracting && !disabledReason;

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
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
                  onClick={() => onRemoveAttachment(attachment.id)}
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

        <div className="flex items-end gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-sm focus-within:ring-1 focus-within:ring-ring">
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
            className="size-8 shrink-0 rounded-lg"
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
            className="max-h-[200px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[0.95rem] leading-6 outline-none placeholder:text-muted-foreground"
          />
          <ComposerModelControl
            model={model}
            onModelChange={onModelChange}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
            disabled={isLoading || isExtracting}
          />
          {isLoading ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-8 shrink-0 rounded-lg"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square className="size-4 fill-current" aria-hidden />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="size-8 shrink-0 rounded-lg"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="Send"
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          )}
        </div>
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
};

function ComposerModelControl({
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
}: {
  model: ModelChoice;
  onModelChange: (choice: ModelChoice) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
}) {
  const instance = useInstanceSettings();
  const models = MODELS.filter((m) => isModelAllowed(instance, modelKey(m)));
  const selectedReasoning = REASONING_EFFORTS.find((effort) => effort.value === reasoningEffort);
  const reasoningDisabled = model.provider !== "openai";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg px-2.5"
          disabled={disabled}
          aria-label="Choose reasoning level and model"
        >
          <span className="font-medium">{selectedReasoning?.label ?? "Medium"}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Reasoning</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={reasoningEffort}
          onValueChange={(value) => {
            if (isReasoningValue(value)) onReasoningEffortChange(value);
          }}
        >
          {REASONING_EFFORTS.map((effort) => (
            <DropdownMenuRadioItem key={effort.value} value={effort.value} disabled={reasoningDisabled}>
              {effort.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {reasoningDisabled ? (
          <DropdownMenuItem disabled className="text-xs">
            OpenAI models only
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="min-w-0 flex-1 truncate">Model</span>
            <span className="max-w-32 truncate text-muted-foreground">{model.sublabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            {models.map((m) => (
              <DropdownMenuItem
                key={m.model}
                onSelect={() => onModelChange(m)}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{m.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{m.sublabel}</span>
                </span>
                {m.model === model.model ? <Check className="size-4" aria-hidden /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isReasoningValue(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort.value === value);
}
