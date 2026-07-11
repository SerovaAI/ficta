const SURROGATE_VALUE = /FICTA_(?:[A-Z0-9]{1,12}_)?[0-9a-f]{32}/;

export type ProtectionValueError = "empty" | "protected" | "surrogate" | "absent";

export type ProtectionValueResult = { ok: true; value: string } | { ok: false; reason: ProtectionValueError };

export function validateProtectionValue(input: {
  value: string;
  originalText: string;
  protectedValues: string[];
}): ProtectionValueResult {
  const value = input.value.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (SURROGATE_VALUE.test(value)) return { ok: false, reason: "surrogate" };
  if (!input.originalText.includes(value)) return { ok: false, reason: "absent" };
  if (input.protectedValues.includes(value)) return { ok: false, reason: "protected" };
  return { ok: true, value };
}
