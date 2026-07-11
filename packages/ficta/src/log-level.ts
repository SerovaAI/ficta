// The single verbosity knob for the proxy: FICTA_LOG_LEVEL. Ordered least→most output.
// `trace` is the most verbose structured-log tier; sensitive raw-body capture is controlled by a
// separate ephemeral runtime admin grant. Zero imports here so the
// pii plugin can gate on it without pulling in the config→user-config→plugins→pii cycle.
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

let warnedInvalid = false;

/**
 * Parse FICTA_LOG_LEVEL (case-insensitive, trimmed). Unset or unrecognized → `fallback`.
 * An unrecognized value additionally emits ONE warning per process to stderr (never stdout —
 * stdout may be the wrapped agent's TUI).
 */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) return normalized as LogLevel;
  if (!warnedInvalid) {
    warnedInvalid = true;
    process.stderr.write(`ficta: unrecognized FICTA_LOG_LEVEL "${raw}" — using "${fallback}"\n`);
  }
  return fallback;
}

/** True when a message tagged `at` should be emitted at the configured `level`. */
export function levelEnabled(level: LogLevel, at: LogLevel): boolean {
  return RANK[level] >= RANK[at];
}
