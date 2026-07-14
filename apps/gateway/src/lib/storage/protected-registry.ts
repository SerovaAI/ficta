import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  FICTA_MANAGED_REGISTRY_SCHEMA,
  FICTA_REGISTRY_RELOAD_PATH,
  FICTA_REGISTRY_REVISION_HEADER,
  isManagedRegistryFile,
  isRegistryReloadOk,
  type ManagedRegistryEntry,
  type ManagedRegistryFile,
} from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope, requireScope } from "@/lib/auth/guards.server";
import { SerialTaskQueue, writePrivateFileAtomic } from "./private-file.server";
import { getStorage } from "./storage.server";
import {
  PROTECTED_REGISTRY_ENTITY_TYPES,
  PROTECTED_REGISTRY_ENTRY_SOURCES,
  PROTECTED_REGISTRY_ENTRY_STATUSES,
  PROTECTED_REGISTRY_ENTRY_TYPES,
  PROTECTED_REGISTRY_FORM_BOUNDARIES,
  PROTECTED_REGISTRY_FORM_KINDS,
  PROTECTED_REGISTRY_PROTECTION_KINDS,
  type ProtectedRegistryEntry,
  type ProtectedRegistryEntryInput,
  type ProtectedRegistryEntrySource,
} from "./types";

const ENTRY_IMPORT_MAX = 500;
const FIELD_MAX = 500;
const FORMS_PER_ENTRY_MAX = 20;
const DEFAULT_MANAGED_REGISTRY_FILE = ".data/protected-registry.json";

export interface ProtectedRegistryExport {
  path: string;
  revision: string;
  entries: number;
  values: number;
}

/** Result of the proxy-reload half of a publish. Failure is partial success: the file is written. */
export type ProtectedRegistryReloadResult =
  | {
      ok: true;
      revision: string;
      added: number;
      total: number;
      loaded: number;
      filesRead: number;
      /** Other configured registry files the proxy could not find — a proxy-config warning, not a
       *  publication failure (this publish's own file is revision-verified). */
      filesMissing: number;
      /** The valid file includes edits/removals that the running proxy intentionally defers. */
      restartRequired: boolean;
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
          protectionKind: "literal",
          value,
          forms: [],
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
    if (res.status === 409) {
      const json = (await res.json()) as unknown;
      if (
        typeof json === "object" &&
        json !== null &&
        "status" in json &&
        json.status === "invalid_registry" &&
        "message" in json &&
        typeof json.message === "string"
      ) {
        return { ok: false, status: "source_error", message: json.message };
      }
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
    filesRead: registry.filesRead,
    filesMissing: registry.filesMissing,
    restartRequired: registry.restartRequired ?? false,
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
  const protectionKind = readEnum(
    record.protectionKind ?? "literal",
    PROTECTED_REGISTRY_PROTECTION_KINDS,
    "protectionKind",
  );
  const entityType =
    protectionKind === "entity"
      ? readEnum(record.entityType, PROTECTED_REGISTRY_ENTITY_TYPES, "entityType")
      : undefined;
  const forms = normalizeForms(record.forms);
  if (protectionKind === "literal" && forms.some((form) => form.boundary !== "substring")) {
    throw new Error("literal entries cannot declare token-bounded forms; create a separate literal value instead");
  }
  return {
    ...(id ? { id } : {}),
    matterId,
    type,
    protectionKind,
    ...(entityType ? { entityType } : {}),
    value,
    forms,
    source,
    status,
  };
}

function normalizeForms(formsValue: unknown): ProtectedRegistryEntry["forms"] {
  if (formsValue === undefined) return [];
  if (!Array.isArray(formsValue)) throw new Error("forms must be an array");
  const raw = formsValue;
  const forms = new Map<string, ProtectedRegistryEntry["forms"][number]>();
  for (const item of raw) {
    const record = asRecord(item);
    const value = readString(record, "value", { required: true });
    const kind = readEnum(record.kind, PROTECTED_REGISTRY_FORM_KINDS, "form kind");
    const boundary = readEnum(record.boundary, PROTECTED_REGISTRY_FORM_BOUNDARIES, "form boundary");
    const key = normalizeRegistryValue(value);
    const current = forms.get(key);
    if (!current || current.boundary === "token") forms.set(key, { value, kind, boundary });
    if (forms.size > FORMS_PER_ENTRY_MAX) throw new Error(`use at most ${FORMS_PER_ENTRY_MAX} forms per entry`);
  }
  return [...forms.values()];
}

export function renderManagedRegistryFile(entries: ProtectedRegistryEntry[]): {
  body: string;
  revision: string;
  values: number;
} {
  const revision = randomUUID();
  const registryEntries: ManagedRegistryEntry[] = [];
  let values = 0;
  entries.forEach((entry) => {
    if (entry.protectionKind === "entity") {
      if (!entry.entityType) throw new Error(`entity registry entry ${entry.id} has no entity type`);
      const canonical = normalizeRegistryValue(entry.value);
      const forms = entry.forms.filter((form) => normalizeRegistryValue(form.value) !== canonical);
      registryEntries.push({
        id: entry.id,
        protectionKind: "entity",
        entityType: entry.entityType,
        canonicalValue: entry.value,
        forms,
      });
      values += 1 + forms.length;
      return;
    }
    registryEntries.push({
      id: entry.id,
      protectionKind: "literal",
      value: entry.value,
      semanticType: entry.type,
    });
    values++;
    for (const form of entry.forms.filter(
      (form) => normalizeRegistryValue(form.value) !== normalizeRegistryValue(entry.value),
    )) {
      registryEntries.push({
        id: literalFormId(entry.id, form.value),
        protectionKind: "literal",
        value: form.value,
        semanticType: entry.type,
      });
      values++;
    }
  });
  const file: ManagedRegistryFile = {
    schema: FICTA_MANAGED_REGISTRY_SCHEMA,
    revision,
    generatedBy: "ficta-gateway",
    generatedAt: new Date().toISOString(),
    entries: registryEntries,
  };
  if (!isManagedRegistryFile(file)) {
    throw new Error("approved registry contains duplicate ids, conflicting entity forms, or invalid registry data");
  }
  return {
    body: `${JSON.stringify(file, null, 2)}\n`,
    revision,
    values,
  };
}

function literalFormId(entryId: string, value: string): string {
  const digest = createHash("sha256").update(normalizeRegistryValue(value)).digest("hex").slice(0, 16);
  return `${entryId}:form:${digest}`;
}

function normalizeRegistryValue(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
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
