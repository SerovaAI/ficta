import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";

const SURROGATE_VALUE = /FICTA_(?:[A-Z0-9]{1,12}_)?[0-9a-f]{32}/;
const TRAILING_PROSE_PUNCTUATION = /[,.!?;:]+$/u;
const SUBSTANTIVE_TEXT = /[\p{L}\p{N}]/u;
const OUTER_WRAPPERS = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const;

export type ProtectionValueError =
  | "empty"
  | "protected-chat"
  | "protected-registry"
  | "protected-detected"
  | "surrogate"
  | "absent";

export type ProtectionValueCoverage = "chat" | "registry" | "detected";

export interface AutomaticProtectionValues {
  registryValues: string[];
  detectedValues: string[];
}

export type ProtectionValueResult = { ok: true; value: string } | { ok: false; reason: ProtectionValueError };

/**
 * Browser selections often pick up sentence punctuation or visual wrappers. Remove only those edge
 * artifacts; punctuation inside the selected value remains part of the exact chat protection.
 */
export function normalizeHighlightedProtectionValue(rawValue: string): string {
  let value = rawValue.trim();
  let changed = true;

  while (value && changed) {
    changed = false;

    const withoutTerminalPunctuation = value.replace(TRAILING_PROSE_PUNCTUATION, "").trimEnd();
    if (withoutTerminalPunctuation !== value) {
      value = withoutTerminalPunctuation;
      changed = true;
    }

    const wrapper = OUTER_WRAPPERS.find(
      ([open, close]) => value.length > open.length + close.length && value.startsWith(open) && value.endsWith(close),
    );
    if (wrapper) {
      value = value.slice(wrapper[0].length, -wrapper[1].length).trim();
      changed = true;
    }
  }

  return SUBSTANTIVE_TEXT.test(value) ? value : "";
}

/** User findings are intentionally omitted: protectedValues is authoritative for active chat additions. */
export function automaticProtectionValues(
  text: string,
  findings: readonly ProtectionPreviewFinding[],
): AutomaticProtectionValues {
  const registryValues = new Set<string>();
  const detectedValues = new Set<string>();
  for (const finding of findings) {
    if (finding.origin === "user") continue;
    const value = text.slice(finding.start, finding.end);
    if (!value) continue;
    if (finding.origin === "registry") registryValues.add(value);
    else detectedValues.add(value);
  }
  return { registryValues: [...registryValues], detectedValues: [...detectedValues] };
}

export function protectionValueCoverage(input: {
  value: string;
  protectedValues: readonly string[];
  registryValues?: readonly string[];
  detectedValues?: readonly string[];
}): ProtectionValueCoverage | undefined {
  if (someProtectionValueMatches(input.registryValues ?? [], input.value)) return "registry";
  if (someProtectionValueMatches(input.detectedValues ?? [], input.value)) return "detected";
  if (someProtectionValueMatches(input.protectedValues, input.value)) return "chat";
  return undefined;
}

export function validateProtectionValue(input: {
  value: string;
  originalText: string;
  protectedValues: readonly string[];
  registryValues?: readonly string[];
  detectedValues?: readonly string[];
}): ProtectionValueResult {
  // Typed values deliberately keep their punctuation. Highlight cleanup happens before this boundary.
  const value = input.value.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (SURROGATE_VALUE.test(value)) return { ok: false, reason: "surrogate" };
  if (!protectionValueAppearsInText(value, input.originalText)) return { ok: false, reason: "absent" };

  const coverage = protectionValueCoverage({ ...input, value });
  if (coverage) return { ok: false, reason: `protected-${coverage}` };
  return { ok: true, value };
}

function someProtectionValueMatches(values: readonly string[], candidate: string): boolean {
  return values.some((value) => protectionValuesEquivalent(value, candidate));
}

function protectionValuesEquivalent(protectedValue: string, candidate: string): boolean {
  return protectionValuePattern(protectedValue, true).test(candidate.trim());
}

function protectionValueAppearsInText(value: string, text: string): boolean {
  return protectionValuePattern(value, false).test(text);
}

/** Mirrors the engine policy: word/name-like values case-expand, digit-bearing opaque values do not. */
function protectionValuePattern(value: string, anchored: boolean): RegExp {
  const source = flexiblePatternSource(value);
  const pattern = anchored ? `^(?:${source})$` : source;
  return new RegExp(pattern, isCaseExpandable(value) ? "iu" : "u");
}

function isCaseExpandable(value: string): boolean {
  if (/\d/.test(value)) return false;
  let letters = 0;
  for (const character of value) {
    if ((character >= "a" && character <= "z") || (character >= "A" && character <= "Z")) letters++;
    if (letters >= 2) return true;
  }
  return false;
}

function flexiblePatternSource(value: string): string {
  return value
    .split(/(\s+)/u)
    .map((part) =>
      /\s/u.test(part) ? "(?:[^\\S\\r\\n]+|[^\\S\\r\\n]*(?:\\r\\n|\\r|\\n)[^\\S\\r\\n]*)" : escapeRegExp(part),
    )
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
