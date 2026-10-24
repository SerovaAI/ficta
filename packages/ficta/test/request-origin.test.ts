import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedHostNames, fromBrowser, hostHeaderAllowed } from "../src/request-origin.js";

const ENV_KEYS = ["FICTA_CONFIG_FILE", "FICTA_LOG_LEVEL", "FICTA_UPSTREAM", "FICTA_ALLOWED_HOSTS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FICTA_CONFIG_FILE = "0";
  process.env.FICTA_LOG_LEVEL = "silent";
  process.env.FICTA_UPSTREAM = "http://127.0.0.1:1";
  delete process.env.FICTA_ALLOWED_HOSTS;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Raw HTTP so the test controls Host and browser headers exactly. */
function send(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("Host and Origin checks", () => {
  it("accepts IP literals, loopback names and configured names only", () => {
    const allowed = allowedHostNames({ FICTA_ALLOWED_HOSTS: "proxy.internal:8787, Ficta.Example" });
    for (const host of [
      "127.0.0.1:8787",
      "localhost:8787",
      "[::1]:8787",
      "10.0.0.5:8787",
      "proxy.internal",
      "ficta.example",
      undefined,
    ]) {
      expect(hostHeaderAllowed(host, allowed), String(host)).toBe(true);
    }
    for (const host of ["attacker.example:8787", "127.0.0.1.attacker.example", "localhost.attacker.example", "evil"]) {
      expect(hostHeaderAllowed(host, allowed), host).toBe(false);
    }
  });

  it("treats Origin or a cross-site Sec-Fetch-Site as browser provenance, and Node's fetch as not", () => {
    expect(fromBrowser(new Headers({ origin: "http://attacker.example" }))).toBe(true);
    expect(fromBrowser(new Headers({ origin: "null" }))).toBe(true);
    expect(fromBrowser(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(fromBrowser(new Headers({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(fromBrowser(new Headers({ "sec-fetch-site": "none", "sec-fetch-mode": "cors" }))).toBe(false);
    expect(fromBrowser(new Headers({ "sec-fetch-mode": "cors" }))).toBe(false);
  });

  it("refuses a rebound Host on control and provider routes alike", async () => {
    const { startProxy } = await import("../src/server.js");
    const proxy = await startProxy({ port: 0, plugins: [] });
    try {
      const rebound = { host: `attacker.example:${proxy.port}`, "content-type": "application/json" };
      const patch = await send(proxy.port, {
        method: "PATCH",
        path: "/__ficta/config",
        headers: rebound,
        body: JSON.stringify({ failClosed: false }),
      });
      expect(patch.status).toBe(403);
      expect(patch.body).toContain("FICTA_ALLOWED_HOSTS");
      expect((await send(proxy.port, { method: "GET", path: "/__ficta/status", headers: rebound })).status).toBe(403);
      expect(
        (await send(proxy.port, { method: "POST", path: "/v1/chat/completions", headers: rebound, body: "{}" })).status,
      ).toBe(403);
      // The same request under the proxy's own address still works.
      const ok = await send(proxy.port, {
        method: "GET",
        path: "/__ficta/status",
        headers: { host: `127.0.0.1:${proxy.port}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await proxy.close();
    }
  });

  it("accepts a name listed in FICTA_ALLOWED_HOSTS", async () => {
    process.env.FICTA_ALLOWED_HOSTS = "proxy.internal";
    const { startProxy } = await import("../src/server.js");
    const proxy = await startProxy({ port: 0, plugins: [] });
    try {
      const res = await send(proxy.port, {
        method: "GET",
        path: "/__ficta/status",
        headers: { host: `proxy.internal:${proxy.port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await proxy.close();
    }
  });

  it("refuses cross-site browser requests to every control route", async () => {
    const { startProxy } = await import("../src/server.js");
    const proxy = await startProxy({ port: 0, plugins: [] });
    const host = `127.0.0.1:${proxy.port}`;
    try {
      for (const [method, path, body] of [
        ["PATCH", "/__ficta/config", JSON.stringify({ failClosed: false })],
        ["PATCH", "/__ficta/trace-capture", JSON.stringify({ enabled: true })],
        ["POST", "/__ficta/registry/reload", ""],
        ["GET", "/__ficta/status", undefined],
      ] as const) {
        for (const browser of [{ origin: "http://attacker.example" }, { "sec-fetch-site": "cross-site" }]) {
          const res = await send(proxy.port, {
            method,
            path,
            headers: { host, "content-type": "application/json", ...browser },
            body,
          });
          expect(res.status, `${method} ${path} ${JSON.stringify(browser)}`).toBe(403);
        }
      }
      // A local process (Node fetch: no Origin, `sec-fetch-mode: cors`) is unaffected.
      const res = await fetch(`http://${host}/__ficta/trace-capture`);
      expect(res.status).toBe(200);
    } finally {
      await proxy.close();
    }
  });
});
