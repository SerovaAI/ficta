import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  isManagedRegistryFile,
  type ManagedRegistryEntityForm,
  type ManagedRegistryEntry,
} from "@serovaai/ficta-protocol";
import { envEnabled } from "../engine/env-flags.js";
import type {
  PluginDiscovery,
  ProtectedValue,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "../engine/plugins/types.js";
import {
  type ProtectionRecord,
  protectionRecordSurfaces,
  type RegisteredEntityForm,
  type StructuredRegistrySourceCapabilities,
} from "../engine/protection.js";

interface ManagedRegistryFileStat {
  file: string;
  exists: boolean;
  loaded: number;
  revision?: string;
  error?: "read error" | "invalid json" | "unsupported json" | "registry conflict";
}

interface ManagedRegistryStats {
  enabled: boolean;
  pathSetting: string;
  loaded: number;
  skippedEmpty: number;
  skippedDuplicate: number;
  filesRead: number;
  filesMissing: number;
  filesErrored: number;
  revisions: string[];
  files: ManagedRegistryFileStat[];
}

interface ParsedManagedRegistry {
  entries: ManagedRegistryEntry[];
  revision: string;
}

interface ParsedManagedRegistryFile {
  stat: ManagedRegistryFileStat;
  registry: ParsedManagedRegistry;
}

const PLUGIN_NAME = "managed-registry-file";
const DEFAULT_MANAGED_REGISTRY_FILE = ".data/protected-registry.json";
const DEFAULT_ENABLED = "1";

let cachedKey: string | undefined;
let cachedValues: ProtectedValue[] | undefined;
let cachedRecords: ProtectionRecord[] | undefined;
let cachedStats: ManagedRegistryStats | undefined;

export const managedRegistryFilePlugin: RegistrySourcePlugin & StructuredRegistrySourceCapabilities = {
  kind: "registry-source",
  name: PLUGIN_NAME,
  description: "Loads admin-managed literals and entities from managed registry JSON files",
  config: {
    envDefaults: {
      FICTA_REGISTRY_MANAGED_FILE_ENABLED: DEFAULT_ENABLED,
      FICTA_REGISTRY_MANAGED_FILE_PATHS: DEFAULT_MANAGED_REGISTRY_FILE,
    },
    bindings: [
      { env: "FICTA_REGISTRY_MANAGED_FILE_ENABLED", path: ["registry", "managed_file", "enabled"], kind: "boolean" },
      {
        env: "FICTA_REGISTRY_MANAGED_FILE_PATHS",
        path: ["registry", "managed_file", "paths"],
        kind: "string-array-colon",
      },
    ],
    sections: [{ path: ["registry", "managed_file"], keys: ["enabled", "paths"] }],
  },
  setup: {
    registrySources: (ctx) => [managedRegistrySetupSource(ctx.env)],
  },
  discover: discoverManagedRegistryFiles,
  loadValues: loadManagedRegistryValues,
  loadProtectionRecords: loadManagedRegistryProtectionRecords,
  fatalLoadErrors: true,
};

function loadManagedRegistryValues(): ProtectedValue[] {
  const key = cacheKey();
  if (cachedValues && cachedRecords && cachedKey === key) return cachedValues;

  const stats = emptyStats();
  const values: ProtectedValue[] = [];
  const records: ProtectionRecord[] = [];
  const seenValues = new Set<string>();
  const parsedFiles: ParsedManagedRegistryFile[] = [];

  if (!stats.enabled) {
    cachedKey = key;
    cachedValues = values;
    cachedRecords = records;
    cachedStats = stats;
    return values;
  }

  for (const file of managedRegistryPaths()) {
    const stat: ManagedRegistryFileStat = { file, exists: existsSync(file), loaded: 0 };
    stats.files.push(stat);
    if (!stat.exists) {
      stats.filesMissing++;
      continue;
    }

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      stats.filesErrored++;
      stat.error = "read error";
      throw new Error(`could not read managed registry file ${file}`);
    }

    stats.filesRead++;
    const parsed = parseManagedRegistryJson(text);
    if (!parsed.ok) {
      stats.filesErrored++;
      stat.error = parsed.error;
      throw new Error(`invalid managed registry file ${file}: ${parsed.error}`);
    }

    if (parsed.registry.revision) {
      stat.revision = parsed.registry.revision;
      if (!stats.revisions.includes(parsed.registry.revision)) stats.revisions.push(parsed.registry.revision);
    }

    parsedFiles.push({ stat, registry: parsed.registry });
  }

  try {
    validateManagedRegistrySet(parsedFiles);
  } catch (error) {
    stats.filesErrored++;
    cachedStats = stats;
    throw error;
  }
  for (const { stat, registry } of parsedFiles) {
    for (const entry of registry.entries) {
      const record = protectionRecord(entry);
      records.push(record);
      for (const surface of protectionRecordSurfaces(record)) {
        if (seenValues.has(surface.value)) {
          stats.skippedDuplicate++;
          continue;
        }
        seenValues.add(surface.value);
        values.push(surface);
        stat.loaded++;
      }
    }
  }

  values.sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));
  stats.loaded = values.length;
  cachedKey = key;
  cachedValues = values;
  cachedRecords = records;
  cachedStats = stats;
  return values;
}

function loadManagedRegistryProtectionRecords(): ProtectionRecord[] {
  loadManagedRegistryValues();
  return cachedRecords ?? [];
}

function discoverManagedRegistryFiles(): PluginDiscovery[] {
  const stats = loadManagedRegistryStats();
  return [managedRegistryDiscovery(stats)];
}

function loadManagedRegistryStats(): ManagedRegistryStats {
  loadManagedRegistryValues();
  return cachedStats ?? emptyStats();
}

/**
 * Counts-only view of the last managed-registry load for the reload endpoint. Never contains values
 * or file contents.
 */
export function managedRegistryLoadCounts(): {
  loaded: number;
  filesRead: number;
  filesMissing: number;
  filesErrored: number;
  revisions: string[];
} {
  const stats = loadManagedRegistryStats();
  return {
    loaded: stats.loaded,
    filesRead: stats.filesRead,
    filesMissing: stats.filesMissing,
    filesErrored: stats.filesErrored,
    revisions: [...stats.revisions],
  };
}

/**
 * Drop the memoized load so the next `loadValues()` re-reads the files. The registry-reload endpoint
 * calls this before reloading: the stat-based cache key already catches ordinary edits, but an explicit
 * reset also covers a rewrite that lands with an identical `{mtimeMs, size}` fingerprint (same-ms write
 * of a same-length file).
 */
export function resetManagedRegistryFilePluginCache(): void {
  cachedKey = undefined;
}

/** Keep request-time inspection on the last good snapshot after an explicit reload is rejected. */
export function retainManagedRegistryFilePluginCacheForCurrentFiles(): void {
  if (cachedValues && cachedRecords && cachedStats) cachedKey = cacheKey();
}

export function resetManagedRegistryFilePluginCacheForTests(): void {
  cachedKey = undefined;
  cachedValues = undefined;
  cachedRecords = undefined;
  cachedStats = undefined;
}

function managedRegistrySetupSource(env: NodeJS.ProcessEnv): RegistrySetupSource {
  const paths = (env.FICTA_REGISTRY_MANAGED_FILE_PATHS ?? DEFAULT_MANAGED_REGISTRY_FILE).split(":").filter(Boolean);
  const existing = paths.filter((path) => existsSync(path));
  const label =
    existing.length > 0
      ? `Managed registry files — found ${existing.join(", ")}`
      : `Managed registry files — load admin-approved business values (${paths.join(":")})`;

  return {
    id: `${PLUGIN_NAME}/json-files`,
    label,
    defaultEnabled: envEnabled(env.FICTA_REGISTRY_MANAGED_FILE_ENABLED, DEFAULT_ENABLED === "1"),
    async enabledValues(ctx) {
      const nextPaths = await ctx.promptText(
        "Managed registry file paths to load (colon-separated)",
        ctx.env.FICTA_REGISTRY_MANAGED_FILE_PATHS ?? DEFAULT_MANAGED_REGISTRY_FILE,
        "Use the absolute path shown by Gateway's Protected Registry export.",
      );
      return {
        FICTA_REGISTRY_MANAGED_FILE_ENABLED: "1",
        FICTA_REGISTRY_MANAGED_FILE_PATHS: nextPaths,
      };
    },
    disabledValues(ctx) {
      return {
        FICTA_REGISTRY_MANAGED_FILE_ENABLED: "0",
        FICTA_REGISTRY_MANAGED_FILE_PATHS: ctx.env.FICTA_REGISTRY_MANAGED_FILE_PATHS ?? DEFAULT_MANAGED_REGISTRY_FILE,
      };
    },
  };
}

function managedRegistryDiscovery(stats: ManagedRegistryStats): PluginDiscovery {
  if (!stats.enabled) {
    return {
      id: `${PLUGIN_NAME}/json-files`,
      plugin: PLUGIN_NAME,
      label: "managed registry files",
      status: "disabled",
      valueCount: 0,
      message: "disabled by config/env (registry.managed_file.enabled=false or FICTA_REGISTRY_MANAGED_FILE_ENABLED=0)",
    };
  }

  const details = stats.files.map(
    (file) => `${file.file}: ${file.error ? file.error : file.exists ? `${file.loaded} loaded` : "not found"}`,
  );
  if (stats.filesErrored > 0) {
    return {
      id: `${PLUGIN_NAME}/json-files`,
      plugin: PLUGIN_NAME,
      label: "managed registry files",
      status: "error",
      valueCount: stats.loaded,
      message:
        stats.loaded > 0
          ? `loaded ${stats.loaded} value(s), but could not read ${stats.filesErrored} file(s)`
          : `could not read ${stats.filesErrored} file(s)`,
      details,
    };
  }
  if (stats.loaded > 0) {
    return {
      id: `${PLUGIN_NAME}/json-files`,
      plugin: PLUGIN_NAME,
      label: "managed registry files",
      status: "loaded",
      valueCount: stats.loaded,
      message: `read ${stats.filesRead} file(s)`,
      details,
    };
  }
  if (stats.filesRead > 0) {
    return {
      id: `${PLUGIN_NAME}/json-files`,
      plugin: PLUGIN_NAME,
      label: "managed registry files",
      status: "available",
      valueCount: 0,
      message: skippedOnlyMessage(stats) ?? "file(s) found but no values met the filters",
      details,
    };
  }
  return {
    id: `${PLUGIN_NAME}/json-files`,
    plugin: PLUGIN_NAME,
    label: "managed registry files",
    status: "not_found",
    valueCount: 0,
    message: `looked for ${stats.pathSetting}`,
    details,
  };
}

function parseManagedRegistryJson(text: string):
  | {
      ok: true;
      registry: ParsedManagedRegistry;
    }
  | { ok: false; error: "invalid json" | "unsupported json" } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid json" };
  }

  if (!isManagedRegistryFile(json)) return { ok: false, error: "unsupported json" };

  return {
    ok: true,
    registry: {
      revision: json.revision,
      entries: json.entries,
    },
  };
}

function protectionRecord(entry: ManagedRegistryEntry): ProtectionRecord {
  const meta: ProtectedValue = {
    name: `managed-registry:${entry.id}`,
    value: entry.protectionKind === "entity" ? entry.canonicalValue : entry.value,
    source: "managed-registry-file",
    plugin: PLUGIN_NAME,
    kind: "custom",
    confidence: "exact",
  };
  if (entry.protectionKind === "literal") {
    return {
      protectionKind: "literal",
      protectionId: entry.id,
      value: entry.value,
      semanticType: entry.semanticType,
      authority: "registry",
      confidence: "exact",
      meta,
    };
  }
  const forms = dedupeEntityForms(entry.id, entry.canonicalValue, entry.forms);
  return {
    protectionKind: "entity",
    entityId: entry.id,
    entityType: entry.entityType,
    canonical: {
      formId: formId(entry.id, entry.canonicalValue),
      value: entry.canonicalValue,
      kind: entry.entityType === "organization" ? "legal_name" : "full_name",
    },
    forms,
    provenance: "registry",
    meta,
  };
}

function dedupeEntityForms(
  entityId: string,
  canonicalValue: string,
  forms: readonly ManagedRegistryEntityForm[],
): RegisteredEntityForm[] {
  const canonical = normalizeForm(canonicalValue);
  const byValue = new Map<string, RegisteredEntityForm>();
  for (const form of forms) {
    const normalized = normalizeForm(form.value);
    if (normalized === canonical) continue;
    const candidate: RegisteredEntityForm = {
      formId: formId(entityId, normalized),
      value: form.value,
      kind: form.kind,
      boundary: form.boundary,
    };
    const current = byValue.get(normalized);
    if (!current || current.boundary === "token") byValue.set(normalized, candidate);
  }
  return [...byValue.values()];
}

function validateManagedRegistrySet(files: readonly ParsedManagedRegistryFile[]): void {
  const idOwners = new Map<string, ManagedRegistryFileStat>();
  const valueOwners = new Map<string, { entryId: string; stat: ManagedRegistryFileStat }>();
  for (const { stat, registry } of files) {
    for (const entry of registry.entries) {
      const idOwner = idOwners.get(entry.id);
      if (idOwner) {
        stat.error = "registry conflict";
        throw new Error(
          `duplicate managed registry id ${entry.id} in ${stat.file} (already declared in ${idOwner.file})`,
        );
      }
      idOwners.set(entry.id, stat);
      const values =
        entry.protectionKind === "entity"
          ? [entry.canonicalValue, ...entry.forms.map((form) => form.value)]
          : [entry.value];
      for (const value of values) {
        const normalized = normalizeForm(value);
        const owner = valueOwners.get(normalized);
        if (owner !== undefined && owner.entryId !== entry.id) {
          stat.error = "registry conflict";
          throw new Error(
            `managed registry value in ${stat.file} is assigned to both ${owner.entryId} (${owner.stat.file}) and ${entry.id}`,
          );
        }
        valueOwners.set(normalized, { entryId: entry.id, stat });
      }
    }
  }
}

function normalizeForm(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function formId(entityId: string, value: string): string {
  return `${entityId}:${createHash("sha256").update(normalizeForm(value)).digest("hex").slice(0, 16)}`;
}

function emptyStats(): ManagedRegistryStats {
  return {
    enabled: managedRegistryEnabled(),
    pathSetting: managedRegistryPathSetting(),
    loaded: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0,
    filesRead: 0,
    filesMissing: 0,
    filesErrored: 0,
    revisions: [],
    files: [],
  };
}

function skippedOnlyMessage(stats: ManagedRegistryStats): string | undefined {
  const parts: string[] = [];
  if (stats.skippedDuplicate > 0) parts.push(`${stats.skippedDuplicate} duplicate`);
  if (stats.skippedEmpty > 0) parts.push(`${stats.skippedEmpty} blank`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function managedRegistryEnabled(): boolean {
  return envEnabled(process.env.FICTA_REGISTRY_MANAGED_FILE_ENABLED, DEFAULT_ENABLED === "1");
}

function managedRegistryPathSetting(): string {
  return process.env.FICTA_REGISTRY_MANAGED_FILE_PATHS ?? DEFAULT_MANAGED_REGISTRY_FILE;
}

function managedRegistryPaths(): string[] {
  return managedRegistryPathSetting().split(":").filter(Boolean);
}

function cacheKey(): string {
  return JSON.stringify({
    enabled: managedRegistryEnabled(),
    paths: managedRegistryPathSetting(),
    // Per-file stat fingerprints so an edited/created/deleted registry file busts the cache. Without
    // this the key was content-blind: a gateway "publish" that rewrote the file returned stale values
    // to every consumer (per-request log meta, discover(), doctor) until the process restarted.
    files: managedRegistryPaths().map((file) => fileFingerprint(file)),
  });
}

/** `{mtimeMs, size}` for the cache key; `null` for a missing/unreadable file so create/delete bust too. */
function fileFingerprint(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}
