import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope } from "@/lib/auth/guards.server";
import { getStorage } from "./storage.server";
import {
  PROTECTED_REGISTRY_ENTRY_SOURCES,
  PROTECTED_REGISTRY_ENTRY_STATUSES,
  PROTECTED_REGISTRY_ENTRY_TYPES,
  type ProtectedRegistryEntry,
  type ProtectedRegistryEntryInput,
  type ProtectedRegistryEntrySource,
} from "./types";

const ENTRY_IMPORT_MAX = 500;
const FIELD_MAX = 500;
const ALIASES_PER_ENTRY_MAX = 20;
const DEFAULT_MANAGED_REGISTRY_FILE = ".data/protected-registry.json";
const MANAGED_REGISTRY_SCHEMA = "ficta.managed-registry.v1";

export interface ProtectedRegistryExport {
  path: string;
  entries: number;
  values: number;
  skippedAliases: number;
}

export const fetchProtectedRegistryEntries = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProtectedRegistryEntry[]> => {
    const { orgId } = await requireAdminScope();
    return (await getStorage()).listProtectedRegistryEntries(orgId);
  },
);

export const saveProtectedRegistryEntry = createServerFn({ method: "POST" })
  .validator(validateProtectedRegistryEntry)
  .handler(async ({ data }): Promise<ProtectedRegistryEntry> => {
    const { userId, orgId } = await requireAdminScope();
    return (await getStorage()).upsertProtectedRegistryEntry(orgId, userId, data);
  });

export const importProtectedRegistryEntries = createServerFn({ method: "POST" })
  .validator(validateProtectedRegistryImport)
  .handler(async ({ data }): Promise<ProtectedRegistryEntry[]> => {
    const { userId, orgId } = await requireAdminScope();
    return (await getStorage()).importProtectedRegistryEntries(orgId, userId, data);
  });

export const deleteProtectedRegistryEntry = createServerFn({ method: "POST" })
  .validator(validateProtectedRegistryDelete)
  .handler(async ({ data }): Promise<void> => {
    const { orgId } = await requireAdminScope();
    await (await getStorage()).deleteProtectedRegistryEntry(orgId, data.id);
  });

export const exportProtectedRegistryFile = createServerFn({ method: "POST" }).handler(
  async (): Promise<ProtectedRegistryExport> => {
    const { orgId } = await requireAdminScope();
    const entries = await (await getStorage()).listProtectedRegistryEntries(orgId);
    const approved = entries.filter((entry) => entry.status === "approved");
    const result = renderManagedRegistryFile(approved);
    const path = managedRegistryPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, result.body, { mode: 0o600 });
    return {
      path,
      entries: approved.length,
      values: result.values,
      skippedAliases: result.skippedAliases,
    };
  },
);

function validateProtectedRegistryEntry(input: unknown): ProtectedRegistryEntryInput {
  return normalizeProtectedRegistryEntry(asRecord(input), "manual");
}

function validateProtectedRegistryImport(input: unknown): ProtectedRegistryEntryInput[] {
  if (!Array.isArray(input)) throw new Error("invalid registry import");
  if (input.length > ENTRY_IMPORT_MAX) throw new Error(`import at most ${ENTRY_IMPORT_MAX} registry entries at a time`);
  return input.map((item) => normalizeProtectedRegistryEntry(asRecord(item), "csv"));
}

function validateProtectedRegistryDelete(input: unknown): { id: string } {
  const id = readString(asRecord(input), "id", { required: true });
  return { id };
}

function normalizeProtectedRegistryEntry(
  record: Record<string, unknown>,
  fallbackSource: ProtectedRegistryEntrySource,
): ProtectedRegistryEntryInput {
  const id = readString(record, "id", { required: false });
  const matterId = readString(record, "matterId", { required: false });
  const value = readString(record, "value", { required: true });
  const type = readEnum(record.type, PROTECTED_REGISTRY_ENTRY_TYPES, "type");
  const status = readEnum(record.status ?? "approved", PROTECTED_REGISTRY_ENTRY_STATUSES, "status");
  const source = readEnum(record.source ?? fallbackSource, PROTECTED_REGISTRY_ENTRY_SOURCES, "source");
  return {
    ...(id ? { id } : {}),
    matterId,
    type,
    value,
    aliases: normalizeAliases(record.aliases),
    source,
    status,
  };
}

function normalizeAliases(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;|]/) : [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const alias = cleanString(item);
    const key = alias.toLocaleLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= ALIASES_PER_ENTRY_MAX) break;
  }
  return aliases;
}

function renderManagedRegistryFile(entries: ProtectedRegistryEntry[]): {
  body: string;
  values: number;
  skippedAliases: number;
} {
  const registryEntries: Array<{
    id: string;
    name: string;
    type: ProtectedRegistryEntry["type"];
    scope?: string;
    value: string;
    aliases: string[];
    kind: "custom";
  }> = [];
  let values = 0;
  let skippedAliases = 0;
  entries.forEach((entry) => {
    const aliases = entry.aliases.filter((alias) => {
      if (alias.length >= 4) return true;
      skippedAliases++;
      return false;
    });
    registryEntries.push({
      id: entry.id,
      name: managedRegistryName(entry),
      type: entry.type,
      ...(entry.matterId ? { scope: entry.matterId } : {}),
      value: entry.value,
      aliases,
      kind: "custom",
    });
    values++;
    values += aliases.length;
  });
  return {
    body: `${JSON.stringify(
      {
        schema: MANAGED_REGISTRY_SCHEMA,
        generatedBy: "ficta-gateway",
        generatedAt: new Date().toISOString(),
        entries: registryEntries,
      },
      null,
      2,
    )}\n`,
    values,
    skippedAliases,
  };
}

function managedRegistryName(entry: ProtectedRegistryEntry): string {
  return ["gateway", entry.type, entry.matterId || "global", entry.id].map(safeNamePart).join(":");
}

function safeNamePart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "entry"
  );
}

function managedRegistryPath(): string {
  const configured = (
    process.env.FICTA_GATEWAY_MANAGED_REGISTRY_PATH ?? process.env.FICTA_GATEWAY_PROTECTED_REGISTRY_PATH
  )?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(configured);
  const dataDir = process.env.FICTA_GATEWAY_DATA_DIR?.trim();
  if (!dataDir || dataDir === "memory://") return resolve(DEFAULT_MANAGED_REGISTRY_FILE);
  const base = dataDir.startsWith("memory://") ? DEFAULT_MANAGED_REGISTRY_FILE : dataDir;
  return resolve(join(base, "protected-registry.json"));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid registry payload");
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, opts: { required: boolean }): string {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    if (opts.required) throw new Error(`${key} is required`);
    return "";
  }
  if (typeof raw !== "string") throw new Error(`${key} must be text`);
  const value = cleanString(raw);
  if (opts.required && !value) throw new Error(`${key} is required`);
  return value;
}

function cleanString(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);
}

function readEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`invalid ${label}`);
  return value as T[number];
}
