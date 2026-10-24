import { isIP } from "node:net";
import { isLoopbackAddress } from "./proxy-config-edit.js";

/**
 * Guards against the two ways a web page reaches a loopback-bound proxy. The peer-address check the
 * routes already do cannot see either: both arrive from 127.0.0.1.
 *
 * - DNS rebinding: a page on `attacker.example` re-points that name at 127.0.0.1, after which the
 *   browser treats the proxy as same-origin with the page and can read responses. The request still
 *   carries `Host: attacker.example`, so a proxy that answers only to names it knows is immune.
 *   An IP literal is always accepted: rebinding needs a DNS name, and a page whose origin is the
 *   proxy's own address would have to be served by the proxy.
 * - Cross-site requests: any page can send a PATCH or POST to `http://127.0.0.1:8787` without
 *   reading the answer. Ficta's control routes are called by local processes (the Gateway server,
 *   the CLI), never by a browser, so a request carrying browser provenance (`Origin`, or a
 *   `Sec-Fetch-Site` other than `none`) is refused there. Node's fetch sends neither header.
 */

/** Extra Host names to accept, from `FICTA_ALLOWED_HOSTS` (comma-separated, ports ignored). */
export function allowedHostNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const names = new Set(["localhost"]);
  for (const entry of (env.FICTA_ALLOWED_HOSTS ?? "").split(",")) {
    const name = hostnameOf(entry.trim());
    if (name) names.add(name);
  }
  return names;
}

/** Whether a request's `Host` header names this proxy (see the module comment). */
export function hostHeaderAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (host === undefined || host === "") return true; // HTTP/1.0 or a raw client; browsers always send it
  const name = hostnameOf(host);
  if (name === undefined) return false;
  return isIP(name) !== 0 || isLoopbackAddress(name) || allowed.has(name);
}

/** Whether a request carries browser provenance and so must not reach a control route. */
export function fromBrowser(headers: Headers): boolean {
  if (headers.has("origin")) return true;
  const site = headers.get("sec-fetch-site");
  return site !== null && site !== "none";
}

/** Lower-cased hostname of a `Host` value or bare name, without port or IPv6 brackets. */
function hostnameOf(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const { hostname } = new URL(`http://${value}`);
    return hostname.replace(/^\[|\]$/g, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
