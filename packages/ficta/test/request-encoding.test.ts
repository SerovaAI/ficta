import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeRequestBody, RequestBodyDecodeError } from "../src/request-encoding.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

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

/** Set env vars for a test, returning a restore function that reinstates each prior value. */
function setEnv(vars: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

describe("decodeRequestBody", () => {
  const payload = JSON.stringify({ message: "hello compressed world" });

  it("passes identity and missing encodings through untouched", () => {
    const body = new TextEncoder().encode(payload);
    expect(decodeRequestBody(body, null)).toEqual({ body, decoded: false });
    expect(decodeRequestBody(body, "identity")).toEqual({ body, decoded: false });
    expect(decodeRequestBody(body, "")).toEqual({ body, decoded: false });
  });

  it("decodes gzip, deflate, raw deflate, brotli, and zstd", () => {
    for (const [encoding, encode] of [
      ["gzip", gzipSync],
      ["x-gzip", gzipSync],
      ["deflate", deflateSync],
      ["deflate", deflateRawSync], // header says zlib-wrapped, body is raw — seen in the wild
      ["br", brotliCompressSync],
      ["zstd", zstdCompressSync],
    ] as const) {
      const decoded = decodeRequestBody(new Uint8Array(encode(payload)), encoding);
      expect(decoded.decoded).toBe(true);
      expect(text(decoded.body)).toBe(payload);
    }
  });

  it("decodes comma-separated coding chains in reverse order", () => {
    const chained = new Uint8Array(gzipSync(zstdCompressSync(payload)));
    const decoded = decodeRequestBody(chained, "zstd, gzip");
    expect(decoded.decoded).toBe(true);
    expect(text(decoded.body)).toBe(payload);
  });

  it("throws on an excessive coding chain without decoding any stage", () => {
    const body = new Uint8Array(gzipSync(payload));
    const chain = Array.from({ length: 64 }, () => "gzip").join(", ");
    expect(() => decodeRequestBody(body, chain)).toThrow(RequestBodyDecodeError);
  });

  it("throws on an unsupported coding", () => {
    const body = new TextEncoder().encode(payload);
    expect(() => decodeRequestBody(body, "lzma")).toThrow(RequestBodyDecodeError);
  });

  it("throws on a payload that does not match its declared coding", () => {
    const body = new TextEncoder().encode(payload);
    expect(() => decodeRequestBody(body, "zstd")).toThrow(RequestBodyDecodeError);
  });

  it("skips decoding for an empty body regardless of header", () => {
    expect(decodeRequestBody(new Uint8Array(), "zstd")).toEqual({ body: new Uint8Array(), decoded: false });
  });
});

describe("proxy request decompression", () => {
  it("redacts inside a zstd-compressed body and forwards it decoded", async () => {
    let receivedBody = "";
    let receivedEncoding: string | undefined;
    const upstream = createServer((req, res) => {
      receivedEncoding = req.headers["content-encoding"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    let restoreEnv: (() => void) | undefined;
    try {
      const upstreamPort = await listen(upstream);
      vi.resetModules();
      restoreEnv = setEnv({
        FICTA_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
        FICTA_REGISTRY_ENV_FILE_PATHS: "test/fixtures/secrets.env",
        FICTA_REGISTRY_PROCESS_ENV_ENABLED: "0",
        FICTA_REGISTRY_MIN_LEN: "6",
        FICTA_LOG_LEVEL: "silent",
      });
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const body = JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: `the key is ${AWS}` }],
      });
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "zstd" },
        body: new Uint8Array(zstdCompressSync(body)),
      });
      expect(res.status).toBe(200);
      await res.text();

      expect(receivedEncoding).toBeUndefined();
      const forwarded = JSON.parse(receivedBody) as { messages: Array<{ content: string }> };
      expect(receivedBody).not.toContain(AWS);
      expect(forwarded.messages[0]?.content).toContain("the key is FICTA_");
    } finally {
      proxy?.close();
      await close(upstream);
      restoreEnv?.();
    }
  });

  it("refuses a request whose declared Content-Length exceeds the buffering cap", async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    let restoreEnv: (() => void) | undefined;
    try {
      const upstreamPort = await listen(upstream);
      vi.resetModules();
      restoreEnv = setEnv({
        FICTA_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        FICTA_LOG_LEVEL: "silent",
      });
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      // fetch() computes Content-Length itself, so speak node:http to declare a gigabyte body
      // without sending one — the proxy must refuse from the header alone, before any body byte.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: proxy?.port,
            method: "POST",
            path: "/v1/chat/completions",
            headers: { "content-type": "application/json", "content-length": String(1024 ** 3) },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
            req.destroy();
          },
        );
        req.on("error", reject); // no-op once resolved
        req.flushHeaders();
      });
      expect(status).toBe(413);
      expect(upstreamHits).toBe(0);
    } finally {
      proxy?.close();
      await close(upstream);
      restoreEnv?.();
    }
  });

  it("refuses a body it cannot decode instead of forwarding unscreened bytes", async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    let restoreEnv: (() => void) | undefined;
    try {
      const upstreamPort = await listen(upstream);
      vi.resetModules();
      restoreEnv = setEnv({
        FICTA_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        FICTA_LOG_LEVEL: "silent",
      });
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      for (const [encoding, payload] of [
        ["lzma", new TextEncoder().encode("{}")], // unsupported coding
        ["zstd", new TextEncoder().encode("{not zstd}")], // declared coding, garbage bytes
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-encoding": encoding },
          body: payload,
        });
        expect(res.status).toBe(415);
        const json = (await res.json()) as { error: { type: string } };
        expect(json.error.type).toBe("ficta_request_encoding");
      }
      expect(upstreamHits).toBe(0);
    } finally {
      proxy?.close();
      await close(upstream);
      restoreEnv?.();
    }
  });
});
