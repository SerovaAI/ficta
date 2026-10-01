import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { DetectorUnavailableError } from "../src/engine/redaction-engine.js";
import { piiPlugin } from "../src/plugins/index.js";

// The plain-text content path: a string redacted as message content reaches the out-of-process
// NER backend (Presidio), while the header/query text path keeps its regex-only behaviour.

const PERSON = "Jonathan Appleseed";
const KEY = "content-path-surrogate-key-at-least-32-bytes";

interface Stub {
  server: Server;
  url: string;
  /** The `text` of every /analyze request the stub received. */
  texts: string[];
}

/** A Presidio-shaped analyzer that reports every occurrence of {@link PERSON} as a PERSON span. */
async function startPresidio(): Promise<Stub> {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { text } = JSON.parse(body) as { text: string };
      texts.push(text);
      const spans = [];
      for (let at = text.indexOf(PERSON); at >= 0; at = text.indexOf(PERSON, at + 1)) {
        spans.push({ entity_type: "PERSON", start: at, end: at + PERSON.length, score: 0.9 });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(spans));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, texts };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function engineFor(url: string, failClosed = false): ProtectionEngine {
  return new ProtectionEngine({
    plugins: [piiPlugin],
    config: {
      surrogate: { key: KEY, style: "typed" },
      detection: { failClosed },
      pii: { enabled: true, backends: ["presidio"], presidio: { url } },
    },
  });
}

describe("content text path", () => {
  it("sends a plain string to Presidio and redacts its spans", async () => {
    const stub = await startPresidio();
    try {
      const engine = engineFor(stub.url);
      const text = `Please call ${PERSON} about the contract.`;

      const result = await engine.redactContentDetailed(text);

      expect(stub.texts).toEqual([text]);
      expect(result.text).not.toContain(PERSON);
      expect(result.text).toMatch(/^Please call FICTA_PERSON_[0-9a-f]+ about the contract\.$/);
      expect(result.count).toBe(1);
      expect(result.leaks).toBe(0);
      expect(result.hits).toEqual([expect.objectContaining({ name: "person", source: "pii-presidio" })]);
      expect(result.skippedDetectors).toBeUndefined();
      expect(engine.restoreText(result.text)).toBe(text);
    } finally {
      await close(stub.server);
    }
  });

  it("treats JSON-looking input as text, never as a parsed body", async () => {
    const stub = await startPresidio();
    try {
      const engine = engineFor(stub.url);
      const text = JSON.stringify({ name: PERSON });

      const result = await engine.redactContentDetailed(text);

      // The analyzer saw the raw string, quotes and key included, and the output keeps that shape.
      expect(stub.texts).toEqual([text]);
      expect(result.text).toMatch(/^\{"name":"FICTA_PERSON_[0-9a-f]+"\}$/);
    } finally {
      await close(stub.server);
    }
  });

  it("is available on a request scope, keeping detected values in that scope", async () => {
    const stub = await startPresidio();
    try {
      const engine = engineFor(stub.url);
      const scope = engine.beginRequest();
      const result = await scope.redactContentDetailed(`Ask ${PERSON}.`);

      expect(result.text).not.toContain(PERSON);
      expect(scope.restoreText(result.text)).toBe(`Ask ${PERSON}.`);
      // A different scope never restores a value detected in this one.
      expect(engine.beginRequest().restoreText(result.text)).toBe(result.text);
    } finally {
      await close(stub.server);
    }
  });

  it("leaves the header text path unchanged: Presidio is not called", async () => {
    const stub = await startPresidio();
    try {
      const engine = engineFor(stub.url);
      const text = `Please call ${PERSON} about the contract.`;

      const result = await engine.redactTextDetailed(text);

      expect(stub.texts).toEqual([]);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    } finally {
      await close(stub.server);
    }
  });

  it("applies the engine's detector-outage policy to the content path", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stub = await startPresidio();
    await close(stub.server); // nothing listening: the backend is down

    // Fail-open: the PII plugin degrades past the down backend and the text passes through.
    const open = await engineFor(stub.url, false).redactContentDetailed(`Ask ${PERSON}.`);
    expect(open.text).toBe(`Ask ${PERSON}.`);

    await expect(engineFor(stub.url, true).redactContentDetailed(`Ask ${PERSON}.`)).rejects.toBeInstanceOf(
      DetectorUnavailableError,
    );
    vi.restoreAllMocks();
  });
});
