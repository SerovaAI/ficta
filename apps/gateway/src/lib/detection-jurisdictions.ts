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
