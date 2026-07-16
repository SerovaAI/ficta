import { SUPPORTED_DETECTION_JURISDICTIONS } from "@serovaai/ficta-protocol";

/**
 * Display labels for the protocol's supported detection jurisdictions. The code vocabulary is
 * owned by @serovaai/ficta-protocol (SUPPORTED_DETECTION_JURISDICTIONS); a test asserts every
 * supported code has a label here, so adding a jurisdiction cannot ship an unlabeled picker row.
 */
export const JURISDICTION_LABELS: Record<string, string> = {
  za: "South Africa",
  uk: "United Kingdom",
  us: "United States",
};

export function jurisdictionLabel(code: string): string {
  return JURISDICTION_LABELS[code] ?? code.toUpperCase();
}

/** Toggle one code while keeping the protocol's stable display order. */
export function toggleDetectionJurisdiction(current: readonly string[], code: string): string[] {
  const selected = new Set(current);
  if (selected.has(code)) selected.delete(code);
  else selected.add(code);
  return SUPPORTED_DETECTION_JURISDICTIONS.filter((supported) => selected.has(supported));
}

/** Human summary shared by the panel header and its top-bar trigger. */
export function detectionJurisdictionSummary(jurisdictions: readonly string[]): string {
  if (jurisdictions.length === 0) return "Baseline only";
  if (jurisdictions.length === 1) return "1 additional jurisdiction";
  return `${jurisdictions.length} additional jurisdictions`;
}

export function detectionJurisdictionToggleLabel(count: number, action: "open" | "close"): string {
  const summary =
    count === 0 ? "Baseline only" : count === 1 ? "1 additional jurisdiction" : `${count} additional jurisdictions`;
  return `${action === "open" ? "Open" : "Close"} jurisdiction detection, ${summary.toLowerCase()}`;
}
