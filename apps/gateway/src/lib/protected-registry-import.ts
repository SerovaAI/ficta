import {
  PROTECTED_REGISTRY_ENTRY_STATUSES,
  PROTECTED_REGISTRY_ENTRY_TYPES,
  type ProtectedRegistryEntryInput,
  type ProtectedRegistryEntryStatus,
  type ProtectedRegistryEntryType,
} from "@/lib/storage/types";

export interface ProtectedRegistryImportParseResult {
  entries: ProtectedRegistryEntryInput[];
  warnings: string[];
}

type Column = "matterId" | "type" | "value" | "aliases" | "status";

const DEFAULT_COLUMNS: Column[] = ["matterId", "type", "value", "aliases", "status"];
const HEADER_ALIASES: Record<string, Column> = {
  scope: "matterId",
  scopeid: "matterId",
  scope_id: "matterId",
  record: "matterId",
  recordid: "matterId",
  record_id: "matterId",
  matter: "matterId",
  matterid: "matterId",
  matter_id: "matterId",
  mattercode: "matterId",
  matter_code: "matterId",
  type: "type",
  kind: "type",
  category: "type",
  value: "value",
  name: "value",
  entity: "value",
  identifier: "value",
  aliases: "aliases",
  alias: "aliases",
  also_known_as: "aliases",
  aka: "aliases",
  status: "status",
};

export function parseProtectedRegistryImport(text: string): ProtectedRegistryImportParseResult {
  const warnings: string[] = [];
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length === 0) return { entries: [], warnings: ["No registry rows found."] };

  const first = rows[0] ?? [];
  const header = headerColumns(first);
  const hasHeader = header.some(Boolean);
  const columns = hasHeader ? header : DEFAULT_COLUMNS;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const entries: ProtectedRegistryEntryInput[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + (hasHeader ? 2 : 1);
    const draft = rowToDraft(row, columns);
    if (!draft.value) {
      warnings.push(`Row ${rowNumber} was skipped because value is blank.`);
      return;
    }
    const type = normalizeType(draft.type);
    if (!type) {
      warnings.push(`Row ${rowNumber} was skipped because type "${draft.type}" is not supported.`);
      return;
    }
    const status = normalizeStatus(draft.status);
    if (!status) {
      warnings.push(`Row ${rowNumber} was skipped because status "${draft.status}" is not supported.`);
      return;
    }
    entries.push({
      matterId: draft.matterId,
      type,
      value: draft.value,
      aliases: splitAliases(draft.aliases),
      status,
      source: "csv",
    });
  });

  if (entries.length === 0 && warnings.length === 0) warnings.push("No importable registry entries found.");
  return { entries, warnings };
}

function rowToDraft(row: string[], columns: Array<Column | undefined>) {
  const draft: Record<Column, string> = { matterId: "", type: "", value: "", aliases: "", status: "" };
  columns.forEach((column, index) => {
    if (!column) return;
    draft[column] = clean(row[index] ?? "");
  });
  return {
    matterId: draft.matterId,
    type: draft.type || "other",
    value: draft.value,
    aliases: draft.aliases,
    status: draft.status || "approved",
  };
}

function headerColumns(row: string[]): Array<Column | undefined> {
  return row.map((cell) => HEADER_ALIASES[normalizeHeader(cell)]);
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeType(value: string): ProtectedRegistryEntryType | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (PROTECTED_REGISTRY_ENTRY_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ProtectedRegistryEntryType)
    : undefined;
}

function normalizeStatus(value: string): ProtectedRegistryEntryStatus | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (PROTECTED_REGISTRY_ENTRY_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as ProtectedRegistryEntryStatus)
    : undefined;
}

function splitAliases(value: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const raw of value.split(/[;|]/)) {
    const alias = clean(raw);
    const key = alias.toLocaleLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
