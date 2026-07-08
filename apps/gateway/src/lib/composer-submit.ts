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
  const draftKind = value.trim().length > 0 ? "instructions" : attachmentCount > 0 ? "attachment-only" : "empty";
  return draftKind === "instructions" && !isLoading && !isExtracting && !disabledReason;
}
