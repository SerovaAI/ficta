import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fetchUpstream, isConnectPhaseFailure, type UpstreamRequestInit } from "../src/upstream-fetch.js";

const init: UpstreamRequestInit = { method: "POST", headers: new Headers(), body: "{}" };

function connectError(code: string, address: string): Error {
  return Object.assign(new Error(`connect ${code} ${address}`), { code, syscall: "connect", address, port: 443 });
}

describe("isConnectPhaseFailure", () => {
  it("accepts the slow-IPv4 / dead-IPv6 happy-eyeballs aggregate", () => {
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([
        connectError("ETIMEDOUT", "160.79.104.10"),
        connectError("EHOSTUNREACH", "2607:6bc0::10"),
      ]),
    });
    expect(isConnectPhaseFailure(error)).toBe(true);
  });

  it("accepts single connect failures and undici connect timeouts", () => {
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: connectError("ECONNREFUSED", "::1") }))).toBe(
      true,
    );
    const timeout = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: timeout }))).toBe(true);
  });

  it("rejects failures after the request may have been sent", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: reset }))).toBe(false);
    const bodyTimeout = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" });
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: bodyTimeout }))).toBe(false);
    expect(isConnectPhaseFailure(new TypeError("fetch failed"))).toBe(false);
  });

  it("rejects an aggregate containing a post-connect failure", () => {
    const mixed = new AggregateError([
      connectError("ETIMEDOUT", "203.0.113.1"),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
    ]);
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: mixed }))).toBe(false);
  });
});

describe("fetchUpstream", () => {
  it("retries a connect-phase failure once", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: connectError("ECONNREFUSED", "127.0.0.1") }))
      .mockResolvedValueOnce(new Response("ok"));

    const response = await fetchUpstream("http://upstream.test", init, { fetchImpl, retryDelayMs: 0 });

    expect(await response.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the single retry", async () => {
    const failure = new TypeError("fetch failed", { cause: connectError("ECONNREFUSED", "127.0.0.1") });
    const fetchImpl = vi.fn().mockRejectedValue(failure);

    await expect(fetchUpstream("http://upstream.test", init, { fetchImpl, retryDelayMs: 0 })).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry once the request may have reached the provider", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
    const failure = new TypeError("fetch failed", { cause: reset });
    const fetchImpl = vi.fn().mockRejectedValue(failure);

    await expect(fetchUpstream("http://upstream.test", init, { fetchImpl, retryDelayMs: 0 })).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("forwards method, headers, body and streams the response through the dedicated dispatcher", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
        res.end(JSON.stringify({ method: req.method, auth: req.headers["x-api-key"], body }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetchUpstream(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: new Headers({ "x-api-key": "k", "content-type": "application/json" }),
        body: '{"a":1}',
      });

      expect(response.status).toBe(201);
      expect(new Headers(response.headers).get("x-upstream")).toBe("yes");
      expect(await new Response(response.body).json()).toEqual({ method: "POST", auth: "k", body: '{"a":1}' });
    } finally {
      server.close();
    }
  });
});
