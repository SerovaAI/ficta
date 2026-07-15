const FICTA_UPSTREAM_ERROR_TYPE = "ficta_upstream_error";
const UPSTREAM_UNREACHABLE_MESSAGE =
  "The model service couldn’t be reached. Try again, or contact your admin if this continues.";

type ErrorWithRawEvent = Error & { rawEvent?: unknown };

/**
 * Returns calm, actionable copy for errors the Gateway can identify precisely while leaving the
 * original Error untouched for logging and diagnostics. TanStack AI exposes provider response
 * bodies on `rawEvent`; OpenAI places Ficta's error there directly, while Anthropic nests it once.
 */
export function chatErrorMessage(error: Error): string {
  const rawEvent = (error as ErrorWithRawEvent).rawEvent;
  return isFictaUpstreamError(rawEvent) ? UPSTREAM_UNREACHABLE_MESSAGE : error.message;
}

function isFictaUpstreamError(rawEvent: unknown): boolean {
  if (!isRecord(rawEvent)) return false;
  if (rawEvent.type === FICTA_UPSTREAM_ERROR_TYPE) return true;

  const nestedError = rawEvent.error;
  return isRecord(nestedError) && nestedError.type === FICTA_UPSTREAM_ERROR_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
