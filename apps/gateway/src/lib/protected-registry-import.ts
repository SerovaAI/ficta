import {
  PROTECTED_REGISTRY_ENTITY_TYPES,
  PROTECTED_REGISTRY_ENTRY_STATUSES,
  PROTECTED_REGISTRY_ENTRY_TYPES,
  PROTECTED_REGISTRY_FORM_BOUNDARIES,
  PROTECTED_REGISTRY_FORM_KINDS,
  PROTECTED_REGISTRY_PROTECTION_KINDS,
  type ProtectedRegistryEntityType,
  type ProtectedRegistryEntryForm,
  type ProtectedRegistryEntryInput,
  type ProtectedRegistryEntryStatus,
  type ProtectedRegistryEntryType,
  type ProtectedRegistryProtectionKind,
} from "@/lib/storage/types";

export interface ProtectedRegistryImportParseResult {
  entries: ProtectedRegistryEntryInput[];
  warnings: string[];
}

type Column = "protectionKind" | "entityType" | "matterId" | "type" | "value" | "forms" | "status";

const DEFAULT_COLUMNS: Column[] = ["value", "status"];
const HEADERS: Record<string, Column> = {
  protection_kind: "protectionKind",
  entity_type: "entityType",
  matter_id: "matterId",
  type: "type",
  value: "value",
  forms: "forms",
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
    const protectionKind = normalizeProtectionKind(draft.protectionKind);
    if (!protectionKind) {
      warnings.push(`Row ${rowNumber} was skipped because protection kind "${draft.protectionKind}" is not supported.`);
      return;
    }
    const entityType = protectionKind === "entity" ? normalizeEntityType(draft.entityType) : undefined;
    if (protectionKind === "entity" && !entityType) {
      warnings.push(`Row ${rowNumber} was skipped because entity type "${draft.entityType}" is not supported.`);
      return;
    }
    const parsedForms = parseForms(draft.forms);
    if (parsedForms.error) {
      warnings.push(`Row ${rowNumber} was skipped because ${parsedForms.error}.`);
      return;
    }
    if (protectionKind === "literal" && parsedForms.forms.some((form) => form.boundary !== "substring")) {
      warnings.push(`Row ${rowNumber} was skipped because literal forms must use substring boundaries.`);
      return;
    }
    entries.push({
      matterId: draft.matterId,
      type,
      protectionKind,
      ...(entityType ? { entityType } : {}),
      value: draft.value,
      forms: parsedForms.forms,
      status,
      source: "csv",
    });
  });

  if (entries.length === 0 && warnings.length === 0) warnings.push("No importable registry entries found.");
  return { entries, warnings };
}

function rowToDraft(row: string[], columns: Array<Column | undefined>) {
  const draft: Record<Column, string> = {
    protectionKind: "",
    entityType: "",
    matterId: "",
    type: "",
    value: "",
    forms: "",
    status: "",
  };
  columns.forEach((column, index) => {
    if (!column) return;
    draft[column] = clean(row[index] ?? "");
  });
  return {
    protectionKind: draft.protectionKind || "literal",
    entityType: draft.entityType,
    matterId: draft.matterId,
    type: draft.type || "other",
    value: draft.value,
    forms: draft.forms,
    status: draft.status || "approved",
  };
}

function headerColumns(row: string[]): Array<Column | undefined> {
  return row.map((cell) => HEADERS[normalizeHeader(cell)]);
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

function normalizeProtectionKind(value: string): ProtectedRegistryProtectionKind | undefined {
  const normalized = normalizeHeader(value);
  return (PROTECTED_REGISTRY_PROTECTION_KINDS as readonly string[]).includes(normalized)
    ? (normalized as ProtectedRegistryProtectionKind)
    : undefined;
}

function normalizeEntityType(value: string): ProtectedRegistryEntityType | undefined {
  const normalized = normalizeHeader(value);
  return (PROTECTED_REGISTRY_ENTITY_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ProtectedRegistryEntityType)
    : undefined;
}

function parseForms(value: string): { forms: ProtectedRegistryEntryForm[]; error?: string } {
  const forms: ProtectedRegistryEntryForm[] = [];
  const seen = new Set<string>();
  if (!value) return { forms };
  for (const raw of value.split(";")) {
    const parts = raw.split("~").map(clean);
    if (parts.length !== 3) return { forms: [], error: `form "${clean(raw)}" must be value~kind~boundary` };
    const [formValue = "", kind = "", boundary = ""] = parts;
    if (!formValue) return { forms: [], error: "form value is blank" };
    if (!(PROTECTED_REGISTRY_FORM_KINDS as readonly string[]).includes(kind)) {
      return { forms: [], error: `form kind "${kind}" is not supported` };
    }
    if (!(PROTECTED_REGISTRY_FORM_BOUNDARIES as readonly string[]).includes(boundary)) {
      return { forms: [], error: `form boundary "${boundary}" is not supported` };
    }
    const key = formValue.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push({
      value: formValue,
      kind: kind as ProtectedRegistryEntryForm["kind"],
      boundary: boundary as ProtectedRegistryEntryForm["boundary"],
    });
  }
  return { forms };
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
