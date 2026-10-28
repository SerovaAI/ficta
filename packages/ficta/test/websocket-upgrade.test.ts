import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Raw socket handshake — fetch() forbids Connection/Upgrade headers, so speak HTTP/1.1 directly. */
function attemptUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "\r\n",
      );
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(response));
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`timed out waiting for upgrade response; got: ${response}`));
    });
  });
}

describe("websocket upgrade refusal", () => {
  it("answers upgrade attempts with a local 426 and never contacts the upstream", async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    let proxy: Awaited<ReturnType<(typeof import("../src/server.js"))["startProxy"]>> | undefined;
    const savedUpstream = process.env.FICTA_UPSTREAM;
    const savedLogLevel = process.env.FICTA_LOG_LEVEL;
    try {
      const upstreamPort = await listen(upstream);
      vi.resetModules();
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const response = await attemptUpgrade(proxy.port, "/backend-api/codex/responses");
      expect(response).toContain("426");
      expect(response).not.toContain("101 Switching Protocols");
      expect(upstreamHits).toBe(0);

      // A plain request on the same proxy still forwards normally.
      const plain = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      });
      expect(plain.status).toBe(200);
      await plain.text();
      expect(upstreamHits).toBe(1);
    } finally {
      proxy?.close();
      await close(upstream);
      if (savedUpstream === undefined) delete process.env.FICTA_UPSTREAM;
      else process.env.FICTA_UPSTREAM = savedUpstream;
      if (savedLogLevel === undefined) delete process.env.FICTA_LOG_LEVEL;
      else process.env.FICTA_LOG_LEVEL = savedLogLevel;
    }
  });
  it("never logs the launch token when it refuses an upgrade", async () => {
    const token = "tok-must-not-be-logged-ws-4b1e";
    const logDir = mkdtempSync(join(tmpdir(), "ficta-test-ws-logscan-"));
    const saved = { FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL, FICTA_LOG_DIR: process.env.FICTA_LOG_DIR };
    let proxy: Awaited<ReturnType<(typeof import("../src/server.js"))["startProxy"]>> | undefined;
    try {
      vi.resetModules();
      process.env.FICTA_LOG_LEVEL = "debug";
      process.env.FICTA_LOG_DIR = logDir;
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, launchToken: token });

      expect(await attemptUpgrade(proxy.port, `/__ficta_l/${token}/v1/responses`)).toContain("426");

      const scan = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? scan(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")],
        );
      const logs = scan(logDir).join("\n");
      expect(logs).toContain("/__ficta_l/<token>/v1/responses");
      expect(logs).not.toContain(token);
    } finally {
      proxy?.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("hop-by-hop request headers", () => {
  it("drops them before the upstream hop, including names listed in Connection", async () => {
    let received: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((req, res) => {
      received = req.headers;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const saved = { FICTA_UPSTREAM: process.env.FICTA_UPSTREAM, FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL };
    let proxy: Awaited<ReturnType<(typeof import("../src/server.js"))["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      vi.resetModules();
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });
      const port = proxy.port;

      // Written in two parts with no Content-Length, so the body is sent chunked.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/messages",
            method: "POST",
            headers: {
              "content-type": "application/json",
              connection: "keep-alive, x-per-hop",
              "keep-alive": "timeout=5",
              te: "trailers",
              "x-per-hop": "1",
              "x-end-to-end": "1",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.write('{"messages":');
        req.end("[]}");
      });

      expect(status).toBe(200);
      expect(received["keep-alive"]).toBeUndefined();
      expect(received.te).toBeUndefined();
      expect(received["x-per-hop"]).toBeUndefined();
      expect(received["x-end-to-end"]).toBe("1");
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
