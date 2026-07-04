// Small shared engine JSON helper. Lives outside the security-critical vault so the plugins layer
// (policy, presidio recognizer, the plugin registry machinery) and wire-restore can share one
// narrowing without importing vault internals.

/** Narrow to a plain JSON object — truthy, `typeof === "object"`, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
