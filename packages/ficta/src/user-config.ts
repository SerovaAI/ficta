import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  envFlag,
  parseBoolean,
  type ConfigBinding,
  type ConfigBindingKind,
  type ConfigSection,
} from "@serovaai/ficta-engine";
import { pluginConfigBindings, pluginConfigSections } from "./plugins/index.js";
import { projectRoot, projectsFilePath, readProjectExcludeNames } from "./project-config.js";

type TomlScalar = string | number | boolean;
type TomlValue = TomlScalar | TomlScalar[];
type TomlTable = { [key: string]: TomlValue | TomlTable };

const CORE_CONFIG_BINDINGS: readonly ConfigBinding[] = [
  { env: "FICTA_REGISTRY_MIN_LEN", path: ["registry", "min_len"], kind: "number" },
  { env: "FICTA_REGISTRY_EXCLUDE_NAMES", path: ["registry", "exclude_names"], kind: "string-array-comma" },
  { env: "FICTA_REQUIRE_REGISTRY", path: ["registry", "require"], kind: "boolean" },
  { env: "FICTA_FAIL_CLOSED", path: ["redaction", "fail_closed"], kind: "boolean" },
  { env: "FICTA_FAIL_CLOSED_DETECTION", path: ["detection", "fail_closed"], kind: "boolean" },
  { env: "FICTA_REDACT_PATHS", path: ["redaction", "redact_paths"], kind: "boolean" },
  { env: "FICTA_RESTORE_INTO_TOOLS", path: ["redaction", "restore_into_tools"], kind: "string" },
  { env: "FICTA_LOG_MAX_BYTES", path: ["logging", "max_bytes"], kind: "number" },
  { env: "FICTA_LOG_ROOT", path: ["logging", "log_root"], kind: "string" },
  { env: "FICTA_LOG_DIR", path: ["logging", "log_dir"], kind: "string" },
  { env: "FICTA_SURROGATE_KEY", path: ["surrogate", "key"], kind: "string" },
  { env: "FICTA_SURROGATE_KEY_FILE", path: ["surrogate", "key_file"], kind: "string" },
  { env: "FICTA_REQUIRE_STABLE_SURROGATE_KEY", path: ["surrogate", "require_stable_key"], kind: "boolean" },
  { env: "FICTA_SURROGATE_STYLE", path: ["surrogate", "style"], kind: "string" },
  { env: "FICTA_PORT", path: ["runtime", "port"], kind: "number" },
  { env: "FICTA_ANTHROPIC_UPSTREAM", path: ["upstreams", "anthropic"], kind: "string" },
  { env: "FICTA_OPENAI_UPSTREAM", path: ["upstreams", "openai"], kind: "string" },
  { env: "FICTA_CHATGPT_UPSTREAM", path: ["upstreams", "chatgpt"], kind: "string" },
  { env: "FICTA_UPSTREAM", path: ["upstreams", "forced"], kind: "string" },
  { env: "FICTA_ALLOW_CUSTOM_UPSTREAM", path: ["upstreams", "allow_custom"], kind: "boolean" },
];

const CORE_SECTION_ORDER: readonly ConfigSection[] = [
  { path: ["registry"], keys: ["min_len", "exclude_names", "require"] },
  { path: ["redaction"], keys: ["fail_closed", "redact_paths", "restore_into_tools"] },
  { path: ["detection"], keys: ["fail_closed"] },
  { path: ["logging"], keys: ["max_bytes", "log_root", "log_dir"] },
  { path: ["surrogate"], keys: ["key", "key_file", "require_stable_key", "style"] },
  { path: ["runtime"], keys: ["port"] },
  { path: ["upstreams"], keys: ["anthropic", "openai", "chatgpt", "forced", "allow_custom"] },
];

function configBindings(): ConfigBinding[] {
  return [...CORE_CONFIG_BINDINGS, ...pluginConfigBindings()];
}

function configSectionOrder(): ConfigSection[] {
  const [registry, ...rest] = CORE_SECTION_ORDER;
  return registry ? [registry, ...pluginConfigSections(), ...rest] : [...pluginConfigSections(), ...rest];
}

let loaded = false;
const loadedConfigEnv = new Set<string>();

function defaultConfigPath(): string {
  return join(homedir(), ".ficta", "config.toml");
}

export function configPath(): string | undefined {
  const setting = process.env.FICTA_CONFIG_FILE;
  if (setting === "0") return undefined;
  return setting ? expandHome(setting) : defaultConfigPath();
}

/**
 * Load ~/.ficta/config.toml into process.env-style runtime settings without overriding explicit env
 * vars, then the current project's exclusion list from ~/.ficta/projects.json
 * (FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES).
 */
export function loadUserConfig(): void {
  if (loaded) return;
  loaded = true;

  const path = configPath();
  if (!path) return;

  if (existsSync(path)) {
    for (const [key, value] of Object.entries(readUserConfig(path))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loadedConfigEnv.add(key);
      }
    }
  }

  const projectsPath = projectsFilePath(path);
  if (projectsPath && process.env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES === undefined) {
    // An unreadable store only means no project exclusions (everything stays protected), so warn
    // rather than block every launch; `ficta review` refuses to overwrite it.
    let names: string | undefined;
    try {
      names = readProjectExcludeNames(projectsPath, projectRoot());
    } catch (error) {
      process.stderr.write(`${(error as Error).message}; project exclusions ignored\n`);
    }
    if (names !== undefined) {
      process.env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES = names;
      loadedConfigEnv.add("FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES");
    }
  }
}

/** Forget what `loadUserConfig()` / key resolution recorded, so tests can simulate a fresh process. */
export function resetUserConfigForTests(): void {
  loaded = false;
  loadedConfigEnv.clear();
  keyActivatedFromFile = undefined;
}

/** True when `loadUserConfig()` supplied this process env key from config.toml, not the shell. */
export function wasLoadedFromUserConfig(key: string): boolean {
  return loadedConfigEnv.has(key);
}

export function writeUserConfig(values: Record<string, string>, path = defaultConfigPath()): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, renderToml(values), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

/** Read an existing TOML config file into the effective FICTA_* setting map (empty if missing). */
export function readUserConfig(path = defaultConfigPath()): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  return configObjectToEnv(parseToml(readFileSync(path, "utf8")));
}

/** Where the active surrogate key came from; `ephemeral` means a random per-process key. */
export type SurrogateKeySource = "env" | "env-key-file" | "config" | "config-key-file" | "ephemeral";

export interface SurrogateKeyStatus {
  /** True when a configured key is active, so surrogates survive a restart. */
  stable: boolean;
  source: SurrogateKeySource;
  /** Resolved key-file path, when the key came from a file. Never the key itself. */
  keyFile?: string;
}

/** A configured surrogate key could not be used, or a stable key is required but none is configured. */
export class SurrogateKeyError extends Error {
  override name = "SurrogateKeyError";
}

const KEY_ENV = "FICTA_SURROGATE_KEY";
const KEY_FILE_ENV = "FICTA_SURROGATE_KEY_FILE";
const KEY_FILE_HEX = /^[0-9a-fA-F]{64}$/;

/** The key value this module activated from a key file, so a re-resolve does not mistake it for a shell key. */
let keyActivatedFromFile: string | undefined;

/** `surrogate.require_stable_key` / `FICTA_REQUIRE_STABLE_SURROGATE_KEY`. */
export function requireStableSurrogateKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.FICTA_REQUIRE_STABLE_SURROGATE_KEY);
}

/**
 * Resolve the surrogate key and activate it as `FICTA_SURROGATE_KEY` for the engine. Precedence, first
 * match wins: `FICTA_SURROGATE_KEY` from the shell, `FICTA_SURROGATE_KEY_FILE` from the shell,
 * `surrogate.key` in config.toml, `surrogate.key_file` in config.toml. With none, the engine falls
 * back to a random per-process key (`ephemeral`). Never generates or persists a key — see
 * {@link ensureSurrogateKey} — and throws {@link SurrogateKeyError} for an unusable key file.
 */
export function resolveSurrogateKey(path = configPath()): SurrogateKeyStatus {
  const env = process.env;
  const key = env[KEY_ENV] && env[KEY_ENV] !== keyActivatedFromFile ? env[KEY_ENV] : undefined;
  const keyFile = env[KEY_FILE_ENV];
  const keyFromShell = Boolean(key) && !loadedConfigEnv.has(KEY_ENV);
  const keyFileFromShell = Boolean(keyFile) && !loadedConfigEnv.has(KEY_FILE_ENV);

  if (keyFromShell) return { stable: true, source: "env" };
  if (keyFile && keyFileFromShell) return activateKeyFile(resolve(expandHome(keyFile)), "env-key-file");
  if (key) return { stable: true, source: "config" };
  if (keyFile) {
    const base = path ? dirname(path) : process.cwd();
    const expanded = expandHome(keyFile);
    return activateKeyFile(isAbsolute(expanded) ? expanded : resolve(base, expanded), "config-key-file");
  }
  if (env[KEY_ENV] === keyActivatedFromFile) delete env[KEY_ENV]; // the key file is no longer configured
  return { stable: false, source: "ephemeral" };
}

/**
 * Resolve the surrogate key and, when `surrogate.require_stable_key` is on, refuse an ephemeral one.
 * The proxy calls this at startup so a deployment that keeps surrogates across restarts (e.g.
 * persisted chat history) fails loudly instead of silently minting tokens it can never restore.
 */
export function checkSurrogateKey(path = configPath()): SurrogateKeyStatus {
  const status = resolveSurrogateKey(path);
  if (!status.stable && requireStableSurrogateKey()) throw new SurrogateKeyError(MISSING_STABLE_KEY);
  return status;
}

const MISSING_STABLE_KEY =
  "surrogate.require_stable_key is set but no surrogate key is configured; set FICTA_SURROGATE_KEY, " +
  "FICTA_SURROGATE_KEY_FILE, or surrogate.key_file in config.toml (or run `ficta setup` to generate one)";

function activateKeyFile(file: string, source: "env-key-file" | "config-key-file"): SurrogateKeyStatus {
  const key = readSurrogateKeyFile(file);
  process.env[KEY_ENV] = key;
  keyActivatedFromFile = key;
  return { stable: true, source, keyFile: file };
}

/**
 * Read a surrogate key file: exactly 64 hex characters (a 256-bit key, e.g. `openssl rand -hex 32`),
 * optionally followed by a newline. On POSIX the file must not be accessible to group or others —
 * the same rule ssh applies to private keys. Errors name the file, never its contents.
 */
export function readSurrogateKeyFile(file: string): string {
  let mode: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new SurrogateKeyError(`surrogate key file ${file} is not a regular file`);
    mode = stat.mode;
  } catch (error) {
    if (error instanceof SurrogateKeyError) throw error;
    throw new SurrogateKeyError(
      `surrogate key file ${file} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new SurrogateKeyError(
      `surrogate key file ${file} is accessible by group/others (mode ${(mode & 0o777).toString(8)}); run \`chmod 600 ${file}\``,
    );
  }
  const key = readFileSync(file, "utf8").trim();
  if (!KEY_FILE_HEX.test(key)) {
    throw new SurrogateKeyError(
      `surrogate key file ${file} must contain exactly 64 hex characters (a 256-bit key, e.g. \`openssl rand -hex 32\`)`,
    );
  }
  return key;
}

/**
 * Ensure a stable local surrogate key exists, so surrogates stay consistent across sessions.
 * No-op if one is already configured (env, key file, or config file). Otherwise generates a 256-bit
 * key, persists it 0600 (merging with any existing config), and activates it for the current
 * process — unless `generate` is false, which leaves the key ephemeral for the caller to reject.
 * The key never leaves the machine and is never printed.
 */
export function ensureSurrogateKey(
  path = configPath(),
  opts: { generate?: boolean } = {},
): { generated: boolean; path?: string; status: SurrogateKeyStatus } {
  let status = resolveSurrogateKey(path);
  if (status.stable || !path) return { generated: false, path, status }; // !path: FICTA_CONFIG_FILE=0
  const values = readUserConfig(path);
  if (values[KEY_ENV] || values[KEY_FILE_ENV]) {
    // Configured in the file but not loaded into this process yet (e.g. setup just wrote it).
    for (const name of [KEY_ENV, KEY_FILE_ENV]) {
      const value = values[name];
      if (value) {
        process.env[name] = value;
        loadedConfigEnv.add(name);
      }
    }
    status = resolveSurrogateKey(path);
    return { generated: false, path, status };
  }
  if (opts.generate === false) return { generated: false, path, status };
  const key = randomBytes(32).toString("hex");
  values[KEY_ENV] = key;
  writeUserConfig(values, path);
  process.env[KEY_ENV] = key;
  loadedConfigEnv.add(KEY_ENV);
  return { generated: true, path, status: { stable: true, source: "config" } };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function renderToml(values: Record<string, string>): string {
  const tree = envToConfigObject(values);
  const lines = ["# Generated by ficta.", "# Shell environment variables override this file."];

  for (const section of configSectionOrder()) appendSection(lines, tree, section.path, section.keys);
  return `${lines.join("\n")}\n`;
}

function appendSection(lines: string[], root: TomlTable, path: readonly string[], keys: readonly string[]): void {
  const table = getTable(root, path);
  if (!table) return;
  const entries = keys
    .map((key): [string, TomlValue | undefined] => [key, tomlValue(table[key])])
    .filter((entry): entry is [string, TomlValue] => entry[1] !== undefined);
  if (entries.length === 0) return;

  lines.push("", `[${path.join(".")}]`);
  for (const [key, value] of entries) lines.push(`${key} = ${formatTomlValue(value)}`);
}

function envToConfigObject(values: Record<string, string>): TomlTable {
  const root: TomlTable = {};
  for (const binding of configBindings()) {
    if (!Object.hasOwn(values, binding.env)) continue;
    setPath(root, binding.path, envValueToToml(values[binding.env] ?? "", binding.kind));
  }
  return root;
}

function configObjectToEnv(root: TomlTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const binding of configBindings()) {
    const value = getPath(root, binding.path);
    const envValue = value === undefined ? undefined : tomlValueToEnv(value, binding.kind);
    if (envValue !== undefined) out[binding.env] = envValue;
  }
  return out;
}

function envValueToToml(value: string, kind: ConfigBindingKind): TomlValue {
  switch (kind) {
    case "boolean":
      return parseBoolean(value) ?? value;
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "string-array-colon":
      return value.split(":").filter(Boolean);
    case "string-array-comma": {
      const trimmed = value.trim();
      if (trimmed.includes(","))
        return trimmed
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
      return trimmed;
    }
    case "string":
      return value;
  }
}

function tomlValueToEnv(value: TomlValue | TomlTable, kind: ConfigBindingKind): string | undefined {
  if (tomlValue(value) === undefined) return undefined;
  switch (kind) {
    case "boolean": {
      if (typeof value === "boolean") return value ? "1" : "0";
      const parsed = typeof value === "string" ? parseBoolean(value) : undefined;
      return parsed === undefined ? String(value) : parsed ? "1" : "0";
    }
    case "number":
      return String(value);
    case "string-array-colon":
      return Array.isArray(value) ? value.map(String).join(":") : String(value);
    case "string-array-comma":
      return Array.isArray(value) ? value.map(String).join(",") : String(value);
    case "string":
      return String(value);
  }
}

function getTable(root: TomlTable, path: readonly string[]): TomlTable | undefined {
  let cursor: TomlTable = root;
  for (const part of path) {
    const next = cursor[part];
    if (!isTable(next)) return undefined;
    cursor = next;
  }
  return cursor;
}

function getPath(root: TomlTable, path: readonly string[]): TomlValue | TomlTable | undefined {
  let cursor: TomlValue | TomlTable | undefined = root;
  for (const part of path) {
    if (!isTable(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(root: TomlTable, path: readonly string[], value: TomlValue): void {
  let cursor = root;
  for (const part of path.slice(0, -1)) {
    const current = cursor[part];
    if (!isTable(current)) cursor[part] = {};
    cursor = cursor[part] as TomlTable;
  }
  cursor[path[path.length - 1] ?? ""] = value;
}

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tomlValue(value: TomlValue | TomlTable | undefined): TomlValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function formatTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(formatTomlScalar).join(", ")}]`;
  return formatTomlScalar(value);
}

function formatTomlScalar(value: TomlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = ensureTable(
        root,
        sectionMatch[1]
          ?.split(".")
          .map((part) => part.trim())
          .filter(Boolean) ?? [],
      );
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    current[key] = parseTomlValue(line.slice(eq + 1).trim());
  }

  return root;
}

function ensureTable(root: TomlTable, path: readonly string[]): TomlTable {
  let cursor = root;
  for (const part of path) {
    const current = cursor[part];
    if (!isTable(current)) cursor[part] = {};
    cursor = cursor[part] as TomlTable;
  }
  return cursor;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw: string): TomlValue {
  if (raw.startsWith("[") && raw.endsWith("]")) return parseTomlArray(raw.slice(1, -1));
  if (raw.startsWith('"') && raw.endsWith('"')) return parseDoubleQuoted(raw);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseTomlArray(raw: string): TomlScalar[] {
  const items: TomlScalar[] = [];
  for (const item of splitTomlArray(raw)) {
    const value = parseTomlValue(item);
    if (Array.isArray(value)) continue;
    items.push(value);
  }
  return items;
}

function splitTomlArray(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      const item = raw.slice(start, i).trim();
      if (item) out.push(item);
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function parseDoubleQuoted(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
