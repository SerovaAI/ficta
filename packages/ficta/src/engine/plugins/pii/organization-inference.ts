import type { ProtectedValue } from "../types.js";

const ORGANIZATION_SOURCE = "pii-presidio-organization-inference";
export const ORGANIZATION_INFERENCE_SCORE = 0.65;

// These are business-name designators, not company values. They only admit a candidate when it is
// structurally in a transaction/payee column or starts with a stem Presidio already identified as an
// organization in this document. Keeping the vocabulary at the designator level avoids a per-client
// deny list while staying narrower than "protect every capitalized phrase".
const BUSINESS_DESIGNATORS = new Set([
  "advisory",
  "bank",
  "capital",
  "cc",
  "consulting",
  "corporation",
  "corp",
  "enterprises",
  "foundation",
  "fund",
  "fzco",
  "group",
  "holdings",
  "inc",
  "incorporated",
  "industries",
  "investment",
  "investments",
  "limited",
  "llc",
  "llp",
  "logistics",
  "ltd",
  "management",
  "partners",
  "plc",
  "properties",
  "resources",
  "services",
  "solutions",
  "supplies",
  "systems",
  "technologies",
  "technology",
  "trust",
  "ventures",
]);

const NAME_CONNECTORS = new Set(["and", "of", "the"]);

const STEM_STOP_WORDS = new Set([
  "account",
  "client",
  "company",
  "counterparty",
  "customer",
  "payee",
  "the",
  "transaction",
  "vendor",
]);

const WORD = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’.-]*/gu;
const DATE_FIELD =
  /^(?:\d{1,2}\s+\p{L}{3,9}\s+\d{2,4}|\p{L}{3,9}\s+\d{1,2},?\s+\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/iu;
const TRANSACTION_HEADER = /\b(?:counterparty|customer|description|details|payee|transaction|vendor)\b/iu;
const AMOUNT_HEADER = /\b(?:amount|balance|credit|debit|payment)\b/iu;

interface WordSpan {
  value: string;
  start: number;
  end: number;
}

/**
 * Add conservative organization candidates which generic NER commonly misses in accounting text:
 * title-cased business names in transaction columns and business-name variants sharing a stem with
 * an organization already detected in the same document.
 */
export function inferOrganizations(text: string, detected: readonly ProtectedValue[]): ProtectedValue[] {
  const tabular = inferTabularOrganizations(text);
  const stems = organizationStems([...detected, ...tabular]);
  const aliases = stems.size > 0 ? inferStemmedAliases(text, stems) : [];
  return dedupeInferences([...tabular, ...aliases]);
}

/** Tabs delimit independent fields, and generic name entities must contain at least one letter. */
export function isInvalidNamedEntitySpan(entityType: string, value: string): boolean {
  return /^(?:LOCATION|ORGANIZATION|PERSON)$/iu.test(entityType) && (value.includes("\t") || !/\p{L}/u.test(value));
}

function inferTabularOrganizations(text: string): ProtectedValue[] {
  const out: ProtectedValue[] = [];
  let transactionTable = false;

  for (const { line, start: lineStart } of linesWithOffsets(text)) {
    if (line.includes("\t") && TRANSACTION_HEADER.test(line) && AMOUNT_HEADER.test(line)) {
      transactionTable = true;
      continue;
    }
    if (!transactionTable || !line.includes("\t")) continue;

    const fields = tabFields(line);
    if (fields.length < 2 || !DATE_FIELD.test(fields[0]?.value.trim() ?? "")) continue;
    const candidate = fields[1];
    if (!candidate) continue;
    const leading = candidate.value.length - candidate.value.trimStart().length;
    const trailing = candidate.value.length - candidate.value.trimEnd().length;
    const value = candidate.value.trim();
    if (!looksLikeBusinessName(value)) continue;
    out.push(organization(value, lineStart + candidate.start + leading, lineStart + candidate.end - trailing));
  }
  return out;
}

function inferStemmedAliases(text: string, stems: ReadonlySet<string>): ProtectedValue[] {
  const out: ProtectedValue[] = [];
  for (const { line, start: lineStart } of linesWithOffsets(text)) {
    for (const segment of lineSegments(line)) {
      const words = wordSpans(segment.value);
      if (words.length < 2 || !isBusinessDesignator(words.at(-1)?.value ?? "")) continue;

      // Use the last known stem before the designator. This trims conversational lead-in such as
      // "do we owe acme capital" down to the entity-shaped "acme capital" span.
      let stemIndex = -1;
      for (let index = 0; index < words.length - 1; index++) {
        if (stems.has(normalizeWord(words[index]?.value ?? ""))) stemIndex = index;
      }
      if (stemIndex === -1) continue;
      const first = words[stemIndex];
      const last = words.at(-1);
      if (!first || !last) continue;
      const value = segment.value.slice(first.start, last.end);
      out.push(organization(value, lineStart + segment.start + first.start, lineStart + segment.start + last.end));
    }
  }
  return out;
}

function organization(value: string, start: number, end: number): ProtectedValue {
  return {
    name: "organization",
    value,
    source: ORGANIZATION_SOURCE,
    kind: "pii",
    confidence: "probabilistic",
    spans: [{ start, end }],
  };
}

function organizationStems(values: readonly ProtectedValue[]): Set<string> {
  const stems = new Set<string>();
  for (const value of values) {
    if (value.name !== "organization") continue;
    for (const word of value.value.match(WORD) ?? []) {
      const normalized = normalizeWord(word);
      if (normalized.length < 3 || STEM_STOP_WORDS.has(normalized) || isBusinessDesignator(normalized)) continue;
      stems.add(normalized);
      break;
    }
  }
  return stems;
}

function looksLikeBusinessName(value: string): boolean {
  const words = value.match(WORD) ?? [];
  if (words.length < 2 || words.length > 8 || !isBusinessDesignator(words.at(-1) ?? "")) return false;
  return words.every((word, index) => isNameCased(word) || (index > 0 && NAME_CONNECTORS.has(normalizeWord(word))));
}

function isNameCased(word: string): boolean {
  const letters = [...word].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return false;
  const joined = letters.join("");
  return joined === joined.toUpperCase() || joined[0] === joined[0]?.toUpperCase();
}

function isBusinessDesignator(value: string): boolean {
  return BUSINESS_DESIGNATORS.has(normalizeWord(value));
}

function normalizeWord(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[.'’]+$/u, "");
}

function tabFields(line: string): Array<{ value: string; start: number; end: number }> {
  const fields: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;
  for (let separator = line.indexOf("\t"); separator !== -1; separator = line.indexOf("\t", start)) {
    fields.push({ value: line.slice(start, separator), start, end: separator });
    start = separator + 1;
  }
  fields.push({ value: line.slice(start), start, end: line.length });
  return fields;
}

function lineSegments(line: string): Array<{ value: string; start: number }> {
  const out: Array<{ value: string; start: number }> = [];
  // Punctuation and table separators are hard entity boundaries. Spaces stay inside a segment so a
  // known organization stem can absorb a multi-word variant before its business designator.
  for (const match of line.matchAll(/[^\t,;:!?()[\]{}|]+/gu)) {
    if (match[0].trim()) out.push({ value: match[0], start: match.index });
  }
  return out;
}

function wordSpans(text: string): WordSpan[] {
  return [...text.matchAll(WORD)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function linesWithOffsets(text: string): Array<{ line: string; start: number }> {
  const out: Array<{ line: string; start: number }> = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0] && match.index === text.length) break;
    out.push({ line: match[0].replace(/(?:\r\n|\r|\n)$/u, ""), start: match.index });
  }
  return out;
}

function dedupeInferences(values: readonly ProtectedValue[]): ProtectedValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const span = value.spans?.[0];
    const key = span ? `${span.start}:${span.end}` : value.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
