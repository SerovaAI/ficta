import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  FICTA_REGISTRY_RELOAD_PATH,
  FICTA_REGISTRY_REVISION_HEADER,
  isRegistryReloadOk,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope, requireScope } from "@/lib/auth/guards.server";
import { SerialTaskQueue, writePrivateFileAtomic } from "./private-file.server";
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
  revision: string;
  entries: number;
  values: number;
  skippedAliases: number;
}

/** Result of the proxy-reload half of a publish. Failure is partial success: the file is written. */
export type ProtectedRegistryReloadResult =
  | {
      ok: true;
      revision: string;
      added: number;
      total: number;
      loaded: number;
      skippedTooShort: number;
      filesRead: number;
      /** Other configured registry files the proxy could not find — a proxy-config warning, not a
       *  publication failure (this publish's own file is revision-verified). */
      filesMissing: number;
    }
  | {
      ok: false;
      status: "unreachable" | "bad_response" | "forbidden" | "not_applied" | "source_error";
      message: string;
    };

export interface ProtectedRegistryPublish extends ProtectedRegistryExport {
  reload: ProtectedRegistryReloadResult;
}

const registryMutationQueue = new SerialTaskQueue();

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

/** Ordinary workspace users may propose chat-protected values, but cannot approve or publish them. */
export const suggestProtectedRegistryEntries = createServerFn({ method: "POST" })
  .validator(validateProtectedRegistrySuggestions)
  .handler(async ({ data }): Promise<ProtectedRegistryEntry[]> => {
    const { userId, orgId } = await requireScope();
    const storage = await getStorage();
    const existing = await storage.listProtectedRegistryEntries(orgId);
    const known = new Set(existing.map((entry) => entry.value.toLocaleLowerCase()));
    const saved: ProtectedRegistryEntry[] = [];
    for (const value of data) {
      const key = value.toLocaleLowerCase();
      if (known.has(key)) continue;
      saved.push(
        await storage.upsertProtectedRegistryEntry(orgId, userId, {
          matterId: "",
          type: "other",
          value,
          aliases: [],
          source: "suggested",
          status: "suggested",
        }),
      );
      known.add(key);
    }
    return saved;
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
    return registryMutationQueue.run(() => writeManagedRegistryFile(orgId));
  },
);

/**
 * One admin action closing the UI → proxy loop: write the managed registry file, then ask the running
 * proxy to reload it (POST /__ficta/registry/reload — loopback-gated, body-less, counts-only response).
 * A reload failure is PARTIAL success — the file is written either way, and the caller gets restart
 * guidance — never a throw. Note the proxy applies additions live; deletions apply on its next restart.
 */
export const publishProtectedRegistry = createServerFn({ method: "POST" }).handler(
  async (): Promise<ProtectedRegistryPublish> => {
    const { orgId } = await requireAdminScope();
    return registryMutationQueue.run(async () => {
      const written = await writeManagedRegistryFile(orgId);
      return { ...written, reload: await requestProxyRegistryReload(written.revision) };
    });
  },
);

/** Render + write the approved entries to the managed registry file. Shared by export and publish. */
async function writeManagedRegistryFile(orgId: string): Promise<ProtectedRegistryExport> {
  const entries = await (await getStorage()).listProtectedRegistryEntries(orgId);
  const approved = entries.filter((entry) => entry.status === "approved");
  const result = renderManagedRegistryFile(approved);
  const path = managedRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writePrivateFileAtomic(path, result.body);
  return {
    path,
    revision: result.revision,
    entries: approved.length,
    values: result.values,
    skippedAliases: result.skippedAliases,
  };
}

const RELOAD_TIMEOUT_MS = 1500;

async function requestProxyRegistryReload(expectedRevision: string): Promise<ProtectedRegistryReloadResult> {
  const { proxyBaseUrl } = await import("@/lib/proxy-base.server");
  const proxyUrl = proxyBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${proxyUrl}${FICTA_REGISTRY_RELOAD_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", [FICTA_REGISTRY_REVISION_HEADER]: expectedRevision },
      signal: controller.signal,
    });
    if (res.status === 403) {
      return {
        ok: false,
        status: "forbidden",
        message: `ficta proxy at ${proxyUrl} refused the reload (loopback-only); restart the proxy to load the file.`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: "bad_response",
        message: `ficta proxy registry reload returned HTTP ${res.status}; restart the proxy to load the file.`,
      };
    }
    const json = (await res.json()) as unknown;
    return verifyRegistryReload(json, expectedRevision);
  } catch {
    return {
      ok: false,
      status: "unreachable",
      message: `ficta proxy is unreachable at ${proxyUrl}; start it (with FICTA_REGISTRY_MANAGED_FILE_PATHS including the exported file) or restart it to load the file.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm that the proxy parsed this exact file generation. HTTP reachability and `added: 0` alone
 * cannot distinguish an unchanged registry from a path mismatch or an unreadable source.
 */
export function verifyRegistryReload(json: unknown, expectedRevision: string): ProtectedRegistryReloadResult {
  if (!isRegistryReloadOk(json)) {
    return {
      ok: false,
      status: "bad_response",
      message: "The proxy reload response was not understood; the proxy and Gateway versions may be out of sync.",
    };
  }
  const { registry } = json;
  if (
    registry.loaded === undefined ||
    registry.filesRead === undefined ||
    registry.filesMissing === undefined ||
    registry.filesErrored === undefined
  ) {
    return {
      ok: false,
      status: "bad_response",
      message: "The proxy does not support verified registry publication yet; restart it to load the written file.",
    };
  }
  if (registry.filesErrored > 0) {
    return {
      ok: false,
      status: "source_error",
      message: `The proxy could not parse ${registry.filesErrored} configured registry file(s) (invalid or unreadable).`,
    };
  }
  if (registry.revision !== expectedRevision) {
    return {
      ok: false,
      status: "not_applied",
      message:
        "The proxy reloaded a different registry file. Align FICTA_GATEWAY_MANAGED_REGISTRY_PATH with FICTA_REGISTRY_MANAGED_FILE_PATHS, then publish again.",
    };
  }
  // A missing file cannot be this publish's own — the revision above only matches a parsed file — so
  // extra configured paths that are absent downgrade to a warning instead of failing the publish.
  return {
    ok: true,
    revision: expectedRevision,
    added: registry.added,
    total: registry.total,
    loaded: registry.loaded,
    skippedTooShort: registry.skippedTooShort ?? 0,
    filesRead: registry.filesRead,
    filesMissing: registry.filesMissing,
  };
}

function validateProtectedRegistryEntry(input: unknown): ProtectedRegistryEntryInput {
  return normalizeProtectedRegistryEntry(asRecord(input), "manual");
}

function validateProtectedRegistryImport(input: unknown): ProtectedRegistryEntryInput[] {
  if (!Array.isArray(input)) throw new Error("invalid registry import");
  if (input.length > ENTRY_IMPORT_MAX) throw new Error(`import at most ${ENTRY_IMPORT_MAX} registry entries at a time`);
  return input.map((item) => normalizeProtectedRegistryEntry(asRecord(item), "csv"));
}

function validateProtectedRegistrySuggestions(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error("suggest at most 20 protected values at a time");
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") throw new Error("suggested values must be text");
    const value = cleanString(item);
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  if (values.length === 0) throw new Error("select a value to suggest");
  return values;
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
  revision: string;
  values: number;
  skippedAliases: number;
} {
  const revision = randomUUID();
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
        revision,
        generatedBy: "ficta-gateway",
        generatedAt: new Date().toISOString(),
        entries: registryEntries,
      },
      null,
      2,
    )}\n`,
    revision,
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
