/**
 * A JSON-safe, bounded description of an upstream transport failure.
 *
 * Node's fetch normally throws a terse `TypeError: fetch failed` and places the useful network
 * error (`ECONNRESET`, `ETIMEDOUT`, TLS failures, and so on) in `cause`. Keep that information
 * without returning stacks, headers, request bodies, URL credentials, or query strings.
 */
export interface UpstreamErrorDiagnostic {
  name: string;
  message: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  address?: string;
  hostname?: string;
  port?: string | number;
  cause?: UpstreamErrorDiagnostic;
  errors?: UpstreamErrorDiagnostic[];
}

const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 4;
const MAX_MESSAGE_LENGTH = 512;
const MAX_FIELD_LENGTH = 128;

/** Extract the useful fetch/cause fields into a safe object for logs and the 502 response. */
export function upstreamErrorDiagnostic(error: unknown): UpstreamErrorDiagnostic {
  return (
    describeError(error, new Set<object>(), 0) ?? {
      name: "Error",
      message: "Unknown upstream transport error",
    }
  );
}

/** Render the diagnostic so clients that only display `error.message` still show the root cause. */
export function formatUpstreamError(diagnostic: UpstreamErrorDiagnostic): string {
  return formatDiagnostic(diagnostic, 0);
}

function describeError(value: unknown, seen: Set<object>, depth: number): UpstreamErrorDiagnostic | undefined {
  if (depth > MAX_CAUSE_DEPTH) return undefined;
  if (typeof value !== "object" || value === null) {
    if (value === undefined || value === null) return undefined;
    return { name: "Error", message: safeText(String(value), MAX_MESSAGE_LENGTH) };
  }
  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const name = safeField(typeof record.name === "string" ? record.name : "Error") || "Error";
  const rawMessage = typeof record.message === "string" ? record.message : String(value);
  const message =
    rawMessage && rawMessage !== "[object Object]"
      ? safeText(rawMessage, MAX_MESSAGE_LENGTH)
      : "Unknown upstream transport error";
  const diagnostic: UpstreamErrorDiagnostic = { name, message };

  assignString(record, diagnostic, "code");
  assignStringOrNumber(record, diagnostic, "errno");
  assignString(record, diagnostic, "syscall");
  assignString(record, diagnostic, "address");
  assignString(record, diagnostic, "hostname");
  assignStringOrNumber(record, diagnostic, "port");

  const cause = describeError(record.cause, seen, depth + 1);
  if (cause) diagnostic.cause = cause;

  if (Array.isArray(record.errors)) {
    const errors = record.errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .map((error) => describeError(error, seen, depth + 1))
      .filter((error): error is UpstreamErrorDiagnostic => error !== undefined);
    if (errors.length > 0) diagnostic.errors = errors;
  }

  return diagnostic;
}

function assignString(
  source: Record<string, unknown>,
  target: UpstreamErrorDiagnostic,
  key: "code" | "syscall" | "address" | "hostname",
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) target[key] = safeField(value);
}

function assignStringOrNumber(
  source: Record<string, unknown>,
  target: UpstreamErrorDiagnostic,
  key: "errno" | "port",
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  else if (typeof value === "string" && value.length > 0) target[key] = safeField(value);
}

function formatDiagnostic(diagnostic: UpstreamErrorDiagnostic, depth: number): string {
  const prefix = diagnostic.message.startsWith(`${diagnostic.name}:`)
    ? diagnostic.message
    : `${diagnostic.name}: ${diagnostic.message}`;
  const metadata = [
    diagnostic.code ? `code=${diagnostic.code}` : undefined,
    diagnostic.errno !== undefined ? `errno=${diagnostic.errno}` : undefined,
    diagnostic.syscall ? `syscall=${diagnostic.syscall}` : undefined,
    diagnostic.address ? `address=${diagnostic.address}` : undefined,
    diagnostic.hostname ? `hostname=${diagnostic.hostname}` : undefined,
    diagnostic.port !== undefined ? `port=${diagnostic.port}` : undefined,
  ].filter((value): value is string => value !== undefined);
  let rendered = metadata.length > 0 ? `${prefix} [${metadata.join(", ")}]` : prefix;

  if (depth < MAX_CAUSE_DEPTH && diagnostic.cause) {
    rendered += `; caused by ${formatDiagnostic(diagnostic.cause, depth + 1)}`;
  }
  if (depth < MAX_CAUSE_DEPTH && diagnostic.errors?.length) {
    rendered += `; causes: ${diagnostic.errors.map((error) => formatDiagnostic(error, depth + 1)).join("; ")}`;
  }
  return rendered;
}

function safeField(value: string): string {
  return safeText(value, MAX_FIELD_LENGTH);
}

function safeText(value: string, maxLength: number): string {
  const withoutSensitiveUrls = value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, sanitizeUrl);
  const flat = [...withoutSensitiveUrls]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

function sanitizeUrl(raw: string): string {
  const match = raw.match(/^(.*?)([),.;:]*)$/);
  const candidate = match?.[1] ?? raw;
  const suffix = match?.[2] ?? "";
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${suffix}`;
  } catch {
    return `[url]${suffix}`;
  }
}
