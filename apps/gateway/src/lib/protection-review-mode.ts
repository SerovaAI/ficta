export const PROTECTION_REVIEW_MODES = ["off", "adaptive", "always"] as const;

export type ProtectionReviewMode = (typeof PROTECTION_REVIEW_MODES)[number];

const MODE_RANK: Record<ProtectionReviewMode, number> = {
  off: 0,
  adaptive: 1,
  always: 2,
};

export function isProtectionReviewMode(value: unknown): value is ProtectionReviewMode {
  return PROTECTION_REVIEW_MODES.includes(value as ProtectionReviewMode);
}

export function effectiveProtectionReviewMode(
  selected: ProtectionReviewMode,
  minimum: ProtectionReviewMode = "off",
): ProtectionReviewMode {
  return MODE_RANK[selected] >= MODE_RANK[minimum] ? selected : minimum;
}

export function protectionReviewModeAllowed(mode: ProtectionReviewMode, minimum: ProtectionReviewMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK[minimum];
}

export function protectionReviewRequiresPreview(mode: ProtectionReviewMode): boolean {
  return mode !== "off";
}

export function protectionPreviewOutcome(mode: ProtectionReviewMode, findingCount: number): "send" | "review" {
  if (mode === "off") return "send";
  return mode === "adaptive" && findingCount === 0 ? "send" : "review";
}

export function protectionReviewModeLabel(mode: ProtectionReviewMode): string {
  if (mode === "off") return "Off";
  if (mode === "adaptive") return "Adaptive";
  return "Always";
}
