// Per-project registry exclusions. `ficta review` offers names from the current project's .env files,
// Doppler config and shell env, so its choices are stored per project rather than only in the global
// ~/.ficta/config.toml. The store is user-local (~/.ficta/projects.json, 0600, beside config.toml) and
// keyed by project root — deliberately never a file inside the repository, so a cloned or checked-in
// repo cannot un-protect anything. Only env var NAMES are stored, never values.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROJECTS_FILE = "projects.json";
const STORE_VERSION = 1;

interface ProjectEntry {
  exclude_names?: string[];
}

interface ProjectStore {
  version: number;
  projects: Record<string, ProjectEntry>;
}

/**
 * The project a launch belongs to: the nearest ancestor of `cwd` (inclusive) holding a `.git` entry,
 * else `cwd` itself. Symlinks are resolved so the same checkout always maps to one key.
 */
export function projectRoot(cwd: string = process.cwd()): string {
  let start: string;
  try {
    start = realpathSync(resolve(cwd));
  } catch {
    start = resolve(cwd);
  }
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** The projects store beside the active config file, or undefined when persistence is disabled. */
export function projectsFilePath(configFile: string | undefined): string | undefined {
  return configFile ? join(dirname(configFile), PROJECTS_FILE) : undefined;
}

/** The comma-joined exclusion list stored for `root`, or undefined when the project has none. */
export function readProjectExcludeNames(path: string, root: string): string | undefined {
  const names = readStore(path).projects[root]?.exclude_names;
  return names && names.length > 0 ? names.join(",") : undefined;
}

/** Persist `root`'s exclusion list (comma-joined; "" removes the project's entry). */
export function writeProjectExcludeNames(path: string, root: string, excludeNames: string): void {
  const store = readStore(path);
  const names = excludeNames
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 0) store.projects[root] = { ...store.projects[root], exclude_names: names };
  else delete store.projects[root];

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function readStore(path: string): ProjectStore {
  const empty: ProjectStore = { version: STORE_VERSION, projects: {} };
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`ficta: ${path} is not valid JSON; fix or remove it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const projects = (parsed as { projects?: unknown }).projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return empty;

  const out: Record<string, ProjectEntry> = {};
  for (const [root, entry] of Object.entries(projects as Record<string, unknown>)) {
    const names = (entry as { exclude_names?: unknown } | null)?.exclude_names;
    if (Array.isArray(names)) out[root] = { exclude_names: names.filter((n): n is string => typeof n === "string") };
  }
  return { version: STORE_VERSION, projects: out };
}
