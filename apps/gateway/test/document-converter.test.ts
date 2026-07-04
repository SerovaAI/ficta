import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkConverterHealth,
  converterConfig,
  DocumentConverterUnavailableError,
  getConverter,
} from "@/lib/documents/converter.server";

/**
 * The converter client is the web app's only coupling to the out-of-process document sidecar. These tests
 * pin its contract (POST /convert multipart → { markdown }) and its failure taxonomy — the /api/extract
 * route fails closed on every one of these, so an un-extracted document is never silently attached.
 */

interface StubOptions {
  /** Body returned from POST /convert (default `{ markdown: "..." }`). */
  markdown?: string;
  /** Force a non-2xx status on /convert. */
  status?: number;
  /** Return this exact (possibly non-JSON) body on /convert. */
  raw?: string;
  /** Never respond to /convert (to exercise the client timeout). */
  hang?: boolean;
  /** Status for GET /health (default 200). */
  health?: number;
}

const ENV_KEYS = ["FICTA_DOC_CONVERTER_URL", "FICTA_DOC_CONVERTER_BACKEND", "FICTA_DOC_CONVERTER_TIMEOUT_MS"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function input(text = "hello"): { bytes: Uint8Array<ArrayBuffer>; filename: string; contentType: string } {
  return { bytes: new Uint8Array(new TextEncoder().encode(text)), filename: "doc.pdf", contentType: "application/pdf" };
}

describe("document converter client", () => {
  it("posts the document and returns the sidecar's markdown", async () => {
    const { result } = await withStub({ markdown: "# Heading\n\nbody" }, () => getConverter().toMarkdown(input()));
    expect(result.markdown).toBe("# Heading\n\nbody");
  });

  describe("config", () => {
    it("defaults to markitdown and the loopback url", () => {
      expect(converterConfig({})).toMatchObject({ backend: "markitdown", url: "http://127.0.0.1:5003" });
    });

    it("selects the docling backend and strips a trailing slash from the url", () => {
      const config = converterConfig({
        FICTA_DOC_CONVERTER_BACKEND: "docling",
        FICTA_DOC_CONVERTER_URL: "http://x:9/",
      });
      expect(config).toMatchObject({ backend: "docling", url: "http://x:9" });
    });
  });

  describe("failure taxonomy (the route fails closed on each)", () => {
    it("throws unreachable when nothing is listening", async () => {
      const port = await closedPort();
      process.env.FICTA_DOC_CONVERTER_URL = `http://127.0.0.1:${port}`;
      await expect(getConverter().toMarkdown(input())).rejects.toMatchObject({ reason: "unreachable" });
    });

    it("throws http_error on a non-2xx response", async () => {
      await expect(withStub({ status: 500 }, () => getConverter().toMarkdown(input()))).rejects.toMatchObject({
        reason: "http_error",
        detail: "500",
      });
    });

    it("throws bad_response on non-JSON", async () => {
      await expect(withStub({ raw: "not json" }, () => getConverter().toMarkdown(input()))).rejects.toMatchObject({
        reason: "bad_response",
      });
    });

    it("throws bad_response when markdown is missing from the payload", async () => {
      await expect(withStub({ raw: "{}" }, () => getConverter().toMarkdown(input()))).rejects.toMatchObject({
        reason: "bad_response",
      });
    });

    it("throws timeout within the configured budget when the sidecar hangs", async () => {
      process.env.FICTA_DOC_CONVERTER_TIMEOUT_MS = "100";
      const started = performance.now();
      await expect(withStub({ hang: true }, () => getConverter().toMarkdown(input()))).rejects.toBeInstanceOf(
        DocumentConverterUnavailableError,
      );
      expect(performance.now() - started).toBeLessThan(1500);
    });
  });

  describe("checkConverterHealth", () => {
    it("reports ok (with backend) when /health returns 200", async () => {
      const { server, port } = await start({});
      process.env.FICTA_DOC_CONVERTER_URL = `http://127.0.0.1:${port}`;
      try {
        expect(await checkConverterHealth()).toMatchObject({ ok: true, backend: "markitdown" });
      } finally {
        await close(server);
      }
    });

    it("reports not-ok (never throws) when the sidecar is down", async () => {
      const port = await closedPort();
      process.env.FICTA_DOC_CONVERTER_URL = `http://127.0.0.1:${port}`;
      const health = await checkConverterHealth();
      expect(health.ok).toBe(false);
      expect(health.detail).toBeTruthy();
    });
  });
});

// --- helpers ---------------------------------------------------------------

function makeStub(opts: StubOptions): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = opts.health ?? 200;
      res.end("ok");
      return;
    }
    // Drain the (multipart) body; the client contract only depends on the response.
    req.on("data", () => {});
    req.on("end", () => {
      if (opts.hang) return; // never respond
      if (opts.status && opts.status >= 400) {
        res.statusCode = opts.status;
        res.end("error");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (opts.raw !== undefined) {
        res.end(opts.raw);
        return;
      }
      res.end(JSON.stringify({ markdown: opts.markdown ?? "converted" }));
    });
  });
}

async function start(opts: StubOptions): Promise<{ server: Server; port: number }> {
  const server = makeStub(opts);
  const port = await listen(server);
  return { server, port };
}

async function withStub<T>(opts: StubOptions, fn: () => Promise<T>): Promise<{ result: T }> {
  const { server, port } = await start(opts);
  process.env.FICTA_DOC_CONVERTER_URL = `http://127.0.0.1:${port}`;
  try {
    return { result: await fn() };
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bind then release a port so a subsequent connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
