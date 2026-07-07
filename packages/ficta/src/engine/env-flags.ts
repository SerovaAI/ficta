/**
 * Single source of truth for parsing boolean-ish env/config strings. Previously every flag had its
 * own ad-hoc parser and they had drifted: some accepted "yes"/"no"/"off"/"disabled" and some did
 * not, so the same value (e.g. FICTA_REDACT_PATHS=yes) was read as ON in one place and OFF in
 * another. Security-relevant flags must not depend on which parser happened to read them.
 */

const TRUTHY = new Set(["1", "true", "on", "enabled", "yes"]);
const FALSY = new Set(["0", "false", "off", "disabled", "no"]);

/** Parse a boolean-ish value. Returns undefined for unset/blank/unrecognized input. */
export function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

/** A flag that defaults to off: true only for an explicit truthy value. */
export function envFlag(value: string | undefined): boolean {
  return parseBoolean(value) === true;
}

/** A flag with an explicit fallback used for unset/unrecognized values. */
export function envEnabled(value: string | undefined, fallback: boolean): boolean {
  return parseBoolean(value) ?? fallback;
}

/**
 * Restore-into-tools policy — how surrogates the model emits into a tool-call argument are handled
 * on the way back:
 *  - `all`      restore every surrogate (registry secrets included) into tool arguments.
 *  - `none`     restore nothing into tool arguments; every surrogate stays a placeholder.
 *  - `detected` restore surrogates for values the agent already read locally (the ephemeral
 *               detected layer — PII/secret-shapes) but keep registry secrets (values the model only
 *               ever saw as placeholders) as placeholders. The default: it fixes file corruption
 *               from echoed local content without reopening the registry-secret exfil channel.
 */
export type RestoreIntoToolsPolicy = "all" | "none" | "detected";

/**
 * Parse `FICTA_RESTORE_INTO_TOOLS`. Accepts the three policy names plus the historical boolean
 * spellings (`1`/`true`/… → `all`, `0`/`false`/… → `none`) so existing configs keep working. Unset
 * or unrecognized input is the safe provenance default `detected`.
 */
export function restoreIntoToolsPolicy(value: string | undefined): RestoreIntoToolsPolicy {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "detected";
  if (normalized === "all") return "all";
  if (normalized === "none" || normalized === "strict") return "none";
  if (normalized === "detected" || normalized === "provenance") return "detected";
  const bool = parseBoolean(normalized);
  if (bool === true) return "all";
  if (bool === false) return "none";
  return "detected";
}
