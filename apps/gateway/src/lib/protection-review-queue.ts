export const PROTECTION_REVIEW_BATCH_MAX = 20;

const SURROGATE_VALUE = /FICTA_(?:[A-Z0-9]{1,12}_)?[0-9a-f]{32}/;

export type PendingProtectionError = "empty" | "duplicate" | "protected" | "surrogate" | "absent" | "limit";

export type PendingProtectionResult = { ok: true; value: string } | { ok: false; reason: PendingProtectionError };

export function validatePendingProtection(input: {
  value: string;
  originalText: string;
  pendingValues: string[];
  protectedValues: string[];
}): PendingProtectionResult {
  const value = input.value.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (SURROGATE_VALUE.test(value)) return { ok: false, reason: "surrogate" };
  if (!input.originalText.includes(value)) return { ok: false, reason: "absent" };
  if (input.protectedValues.includes(value)) return { ok: false, reason: "protected" };
  if (input.pendingValues.includes(value)) return { ok: false, reason: "duplicate" };
  if (input.pendingValues.length >= PROTECTION_REVIEW_BATCH_MAX) return { ok: false, reason: "limit" };
  return { ok: true, value };
}

export interface TextRange {
  start: number;
  end: number;
}

/** Find non-overlapping pending highlights while leaving confirmed protection ranges authoritative. */
export function pendingProtectionRanges(
  text: string,
  pendingValues: string[],
  confirmedRanges: TextRange[],
): TextRange[] {
  const occupied = confirmedRanges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= text.length)
    .map((range) => ({ ...range }));
  const pending: TextRange[] = [];

  for (const value of pendingValues) {
    if (!value) continue;
    let start = 0;
    while (start <= text.length - value.length) {
      const match = text.indexOf(value, start);
      if (match === -1) break;
      const range = { start: match, end: match + value.length };
      if (!occupied.some((entry) => rangesOverlap(entry, range))) {
        pending.push(range);
        occupied.push(range);
      }
      start = match + Math.max(value.length, 1);
    }
  }

  return pending.sort((a, b) => a.start - b.start || a.end - b.end);
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}
