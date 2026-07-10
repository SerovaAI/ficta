import { existsSync, readFileSync, statSync } from "node:fs";
import { isManagedRegistryFile } from "@serovaai/ficta-protocol";
import { envEnabled } from "../engine/env-flags.js";
import type {
  PluginDiscovery,
  ProtectedValue,
  ProtectedValueKind,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "../engine/plugins/types.js";

interface ManagedRegistryFileStat {
  file: string;
  exists: boolean;
  loaded: number;
  revision?: string;
  error?: "read error" | "invalid json" | "unsupported json";
}

interface ManagedRegistryStats {
  enabled: boolean;
  pathSetting: string;
  loaded: number;
  skippedEmpty: number;
  skippedTooShort: number;
  skippedDuplicate: number;
  filesRead: number;
  filesMissing: number;
  filesErrored: number;
  revisions: string[];
  files: ManagedRegistryFileStat[];
}

interface ParsedManagedEntry {
  name: string;
  value: string;
  aliases: string[];
  kind: ProtectedValueKind;
}

interface ParsedManagedRegistry {
  entries: ParsedManagedEntry[];
  revision: string;
}

const PLUGIN_NAME = "managed-registry-file";
const DEFAULT_MANAGED_REGISTRY_FILE = ".data/protected-registry.json";
const DEFAULT_ENABLED = "1";

let cachedKey: string | undefined;
let cachedValues: ProtectedValue[] | undefined;
let cachedStats: ManagedRegistryStats | undefined;

export const managedRegistryFilePlugin: RegistrySourcePlugin = {
  kind: "registry-source",
  name: PLUGIN_NAME,
  description: "Loads exact admin-managed business values from managed registry JSON files",
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
};

function loadManagedRegistryValues(): ProtectedValue[] {
  const key = cacheKey();
  if (cachedValues && cachedKey === key) return cachedValues;

  const stats = emptyStats();
  const values: ProtectedValue[] = [];
  const seen = new Set<string>();

  cachedKey = key;
  cachedValues = values;
  cachedStats = stats;

  if (!stats.enabled) return values;

  const minLen = registryMinLen();
  const add = (entry: ParsedManagedEntry, value: string, suffix?: string): boolean => {
    if (!value) {
      stats.skippedEmpty++;
      return false;
    }
    if (value.length < minLen) {
      stats.skippedTooShort++;
      return false;
    }
    if (seen.has(value)) {
      stats.skippedDuplicate++;
      return false;
    }
    seen.add(value);
    values.push({
      name: suffix ? `${entry.name}:${suffix}` : entry.name,
      value,
      source: "managed-registry-file",
      plugin: PLUGIN_NAME,
      kind: entry.kind,
      confidence: "exact",
    });
    return true;
  };

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
      continue;
    }

    stats.filesRead++;
    const parsed = parseManagedRegistryJson(text);
    if (!parsed.ok) {
      stats.filesErrored++;
      stat.error = parsed.error;
      continue;
    }

    if (parsed.registry.revision) {
      stat.revision = parsed.registry.revision;
      if (!stats.revisions.includes(parsed.registry.revision)) stats.revisions.push(parsed.registry.revision);
    }

    parsed.registry.entries.forEach((entry) => {
      if (add(entry, entry.value)) stat.loaded++;
      entry.aliases.forEach((alias, index) => {
        if (add(entry, alias, `alias-${index + 1}`)) stat.loaded++;
      });
    });
  }

  values.sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));
  stats.loaded = values.length;
  return values;
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
 * Counts-only view of the last managed-registry load, for the reload endpoint's response: values the
 * operator published that were silently dropped by the `FICTA_REGISTRY_MIN_LEN` filter would otherwise
 * read as a successful no-op. Never contains values or file contents.
 */
export function managedRegistryLoadCounts(): {
  loaded: number;
  skippedTooShort: number;
  filesRead: number;
  filesMissing: number;
  filesErrored: number;
  revisions: string[];
} {
  const stats = loadManagedRegistryStats();
  return {
    loaded: stats.loaded,
    skippedTooShort: stats.skippedTooShort,
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
  cachedValues = undefined;
  cachedStats = undefined;
}

export function resetManagedRegistryFilePluginCacheForTests(): void {
  resetManagedRegistryFilePluginCache();
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

function parseManagedRegistryJson(
  text: string,
): { ok: true; registry: ParsedManagedRegistry } | { ok: false; error: "invalid json" | "unsupported json" } {
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
      entries: json.entries.map(({ name, value, aliases, kind }) => ({ name, value, aliases, kind })),
    },
  };
}

function emptyStats(): ManagedRegistryStats {
  return {
    enabled: managedRegistryEnabled(),
    pathSetting: managedRegistryPathSetting(),
    loaded: 0,
    skippedEmpty: 0,
    skippedTooShort: 0,
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
  if (stats.skippedTooShort > 0) parts.push(`${stats.skippedTooShort} shorter than registry.min_len`);
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

function registryMinLen(): number {
  const raw = Number(process.env.FICTA_REGISTRY_MIN_LEN ?? 8);
  if (!Number.isFinite(raw) || raw < 0) return 8;
  return raw;
}

function cacheKey(): string {
  return JSON.stringify({
    enabled: managedRegistryEnabled(),
    paths: managedRegistryPathSetting(),
    minLen: registryMinLen(),
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
