/**
 * Claude Code's `metadata.user_id`: JSON text holding only a random 64-hex `device_id`, plus an
 * `account_uuid` and a `session_id` that are UUIDs or empty. The provider reads it for abuse tracking
 * and the model never sees it. Anything else (extra keys from CLAUDE_CODE_EXTRA_METADATA, another
 * client's free-form id) does not match, so callers keep screening it.
 */
export function isClaudeCodeUserId(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const fields = parsed as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => KEYS.has(key))) return false;
  if (typeof fields.device_id !== "string" || !DEVICE_ID.test(fields.device_id)) return false;
  return (["account_uuid", "session_id"] as const).every((key) => {
    const value = fields[key];
    return value === undefined || value === "" || (typeof value === "string" && UUID.test(value));
  });
}

const KEYS: ReadonlySet<string> = new Set(["device_id", "account_uuid", "session_id"]);
const DEVICE_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
