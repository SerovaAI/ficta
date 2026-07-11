export function canSubmitComposerDraft({
  value,
  attachmentCount = 0,
  isLoading,
  isExtracting,
  disabledReason,
}: {
  value: string;
  attachmentCount?: number;
  isLoading: boolean;
  isExtracting?: boolean;
  disabledReason?: string;
}): boolean {
  return hasComposerDraft(value, attachmentCount) && !isLoading && !isExtracting && !disabledReason;
}

export function hasComposerDraft(value: string, attachmentCount = 0): boolean {
  return value.trim().length > 0 || attachmentCount > 0;
}
