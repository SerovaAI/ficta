import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatUpstreamError, upstreamErrorDiagnostic } from "../src/upstream-error.js";

describe("upstream transport error diagnostics", () => {
  it("surfaces Node fetch's nested network cause", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      errno: -54,
      syscall: "read",
    });
    const error = new TypeError("fetch failed", { cause });

    const diagnostic = upstreamErrorDiagnostic(error);

    expect(diagnostic).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      cause: {
        name: "Error",
        message: "read ECONNRESET",
        code: "ECONNRESET",
        errno: -54,
        syscall: "read",
      },
    });
    expect(formatUpstreamError(diagnostic)).toBe(
      "TypeError: fetch failed; caused by Error: read ECONNRESET [code=ECONNRESET, errno=-54, syscall=read]",
    );
  });

  it("reports aggregate connection attempts", () => {
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("connect ECONNREFUSED ::1"), {
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "::1",
          port: 443,
        }),
        Object.assign(new Error("connect ETIMEDOUT 203.0.113.1"), {
          code: "ETIMEDOUT",
          syscall: "connect",
          address: "203.0.113.1",
          port: 443,
        }),
      ]),
    });

    const diagnostic = upstreamErrorDiagnostic(error);
    const rendered = formatUpstreamError(diagnostic);

    expect(diagnostic.cause?.errors).toHaveLength(2);
    expect(rendered).toContain("ECONNREFUSED");
    expect(rendered).toContain("ETIMEDOUT");
    expect(rendered).toContain("address=::1");
  });

  it("strips URL credentials, query strings, fragments, controls, and stacks", () => {
    const cause = Object.assign(
      new Error("request to https://alice:password@example.com/v1/messages?api_key=very-secret#trace\nfailed"),
      { code: "UND_ERR_SOCKET" },
    );
    const error = new TypeError("fetch failed", { cause });

    const diagnostic = upstreamErrorDiagnostic(error);
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).toContain("https://example.com/v1/messages");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("very-secret");
    expect(serialized).not.toContain("stack");
    expect(diagnostic.cause?.message).not.toContain("\n");
  });

  it("bounds cyclic cause chains", () => {
    const error = new Error("outer") as Error & { cause?: unknown };
    error.cause = error;

    expect(upstreamErrorDiagnostic(error)).toEqual({ name: "Error", message: "outer" });
  });
});

describe("upstream transport error response", () => {
  it("returns the nested connection cause in the proxy's 502", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };
    const unusedPort = await reserveThenReleasePort();
    process.env.FICTA_UPSTREAM = `http://127.0.0.1:${unusedPort}`;
    process.env.FICTA_LOG_LEVEL = "silent";
    process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-upstream-error-"));

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [] });

      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test", messages: [] }),
      });
      const body = (await response.json()) as {
        error: { type: string; message: string; diagnostic: UpstreamDiagnosticShape };
      };

      expect(response.status).toBe(502);
      expect(body.error.type).toBe("ficta_upstream_error");
      expect(body.error.message).toMatch(/ECONNREFUSED/);
      expect(JSON.stringify(body.error.diagnostic)).toMatch(/ECONNREFUSED/);
      expect(body.error.diagnostic).not.toHaveProperty("stack");
    } finally {
      proxy?.close();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

interface UpstreamDiagnosticShape {
  name: string;
  message: string;
  cause?: UpstreamDiagnosticShape;
  errors?: UpstreamDiagnosticShape[];
}

function reserveThenReleasePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
