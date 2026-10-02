/**
 * The proxy's upstream HTTP client: a dedicated undici dispatcher plus a single retry for failures
 * that happen before any request bytes leave the machine.
 *
 * Node's built-in happy-eyeballs (`autoSelectFamily`) is sequential rather than racing: when an
 * attempt exceeds `autoSelectFamilyAttemptTimeout` (250–500ms by default) the attempt is abandoned
 * and the next address is tried. On a high-latency link with an IPv6 address that has no working
 * route — common with VPNs and Tailscale, which assign ULA addresses and default routes — a slow but
 * healthy IPv4 connect is dropped in favour of an unreachable IPv6 one and the request fails with
 * `AggregateError [ETIMEDOUT]`. Agents connecting directly do not fail this way, so the proxy must
 * not be the more fragile path.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { log } from "./logger.js";

/** Per-address connect budget before trying the next address family. Generous because Node cancels rather than races. */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_500;
/** Overall connect budget across all addresses (undici's default). */
const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_DELAY_MS = 250;

/** Codes that can only arise while establishing the connection, before the request is written. */
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

let dispatcher: Agent | undefined;

function upstreamDispatcher(): Agent {
  dispatcher ??= new Agent({
    connect: {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      timeout: CONNECT_TIMEOUT_MS,
    },
  });
  return dispatcher;
}

export interface UpstreamRequestInit {
  method: string;
  headers: Headers;
  body: string | undefined;
}

type FetchImpl = (target: string, init: UpstreamRequestInit) => Promise<Response>;

const defaultFetch: FetchImpl = async (target, init) =>
  (await undiciFetch(target, { ...init, dispatcher: upstreamDispatcher() })) as unknown as Response;

/**
 * Forward a request upstream. A connect-phase failure is retried once: nothing has reached the
 * provider yet, so this is safe even for non-idempotent requests. Any other failure is thrown as-is.
 */
export async function fetchUpstream(
  target: string,
  init: UpstreamRequestInit,
  options: { fetchImpl?: FetchImpl; retryDelayMs?: number; reqId?: number } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  try {
    return await fetchImpl(target, init);
  } catch (err) {
    if (!isConnectPhaseFailure(err)) throw err;
    log.warn({ reqId: options.reqId }, "↻ upstream connect failed before sending; retrying once");
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? CONNECT_RETRY_DELAY_MS));
    return await fetchImpl(target, init);
  }
}

/**
 * True when the fetch error proves the request was never sent: a connect-syscall error, a DNS
 * lookup retry, a connect timeout, or an AggregateError of connection attempts that all failed.
 * Errors after the connection was established (e.g. `ECONNRESET` on read) are not retried.
 */
export function isConnectPhaseFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return isConnectError(cause);
}

function isConnectError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof AggregateError) {
    return value.errors.length > 0 && value.errors.every(isConnectError);
  }
  const { code, syscall } = value as { code?: unknown; syscall?: unknown };
  if (syscall === "connect") return true;
  return typeof code === "string" && CONNECT_PHASE_CODES.has(code);
}
