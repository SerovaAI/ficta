import { medicalRecognizer } from "./medical-recognizer.js";
import { presidioRecognizer } from "./presidio-recognizer.js";
import type { PiiRecognizer } from "./recognizer.js";
import { regexRecognizer } from "./regex-recognizer.js";

/** Legacy env selecting a single PII detection backend (TOML: [pii] backend). */
export const ENV_BACKEND = "FICTA_PII_BACKEND";
/** Env selecting one or more PII detection backends (TOML: [pii] backends). */
export const ENV_BACKENDS = "FICTA_PII_BACKENDS";

/** Always-available in-process default; also the safety floor if a networked backend is unreachable. */
export const DEFAULT_BACKEND = "regex";

/**
 * PII detection backends, keyed by config name — the plugin registry behind the `pii` feature.
 * Exactly one is selected at a time ([pii] backend); adding a backend (AWS Comprehend, Azure, spaCy)
 * is one entry here + its {@link PiiRecognizer} module.
 */
const BUILT_IN: Readonly<Record<string, PiiRecognizer>> = {
  regex: regexRecognizer,
  presidio: presidioRecognizer,
  medical: medicalRecognizer,
};

export interface BackendSelection {
  /** The effective backend name actually used (falls back to `regex` for an unknown config value). */
  name: string;
  /** The selected recognizer. */
  backend: PiiRecognizer;
  /** A configured name that did not resolve to a built-in backend (reported; regex is used instead). */
  unknown?: string;
}

export interface BackendSetSelection {
  /** Effective backends actually used, after filtering unknown configured names. */
  backends: Array<{ name: string; backend: PiiRecognizer }>;
  /** Configured backend names that did not resolve to a built-in backend. */
  unknown: string[];
  /** Configured backend names, normalized and deduped, before unknown filtering/fallback. */
  configured: string[];
}

/** The configured backend name (lowercased). Defaults to `regex` when unset/blank. */
export function selectedBackendName(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_BACKEND]?.trim().toLowerCase() || DEFAULT_BACKEND;
}

/** Configured backend names. `FICTA_PII_BACKENDS` wins; legacy `FICTA_PII_BACKEND` remains supported. */
export function selectedBackendNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ENV_BACKENDS]?.trim() || selectedBackendName(env);
  const names = dedupe(
    raw
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return names.length > 0 ? names : [DEFAULT_BACKEND];
}

/** Resolve the configured backend to a recognizer; an unknown name safely degrades to regex. */
export function activeBackend(env: NodeJS.ProcessEnv = process.env): BackendSelection {
  const name = selectedBackendName(env);
  const backend = BUILT_IN[name];
  if (backend) return { name, backend };
  return { name: DEFAULT_BACKEND, backend: regexRecognizer, unknown: name };
}

/** Resolve all configured backends; unknown names are reported and skipped unless all names are unknown. */
export function activeBackends(env: NodeJS.ProcessEnv = process.env): BackendSetSelection {
  const configured = selectedBackendNames(env);
  const backends: Array<{ name: string; backend: PiiRecognizer }> = [];
  const unknown: string[] = [];

  for (const name of configured) {
    const backend = BUILT_IN[name];
    if (backend) backends.push({ name, backend });
    else unknown.push(name);
  }

  if (backends.length > 0) return { backends, unknown, configured };
  return { backends: [{ name: DEFAULT_BACKEND, backend: regexRecognizer }], unknown, configured };
}

/** Names of the backends ficta knows how to build — for diagnostics and setup. */
export function builtInBackendNames(): string[] {
  return Object.keys(BUILT_IN);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
