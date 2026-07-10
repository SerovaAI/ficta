import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkOpenmedHealth,
  OpenmedUnavailableError,
  openmedRecognizer,
} from "../src/engine/plugins/pii/openmed-recognizer.js";
import type { ProtectedValue } from "../src/plugins/index.js";

interface ExtractRequest {
  text: string;
  confidence_threshold: number;
  lang: string;
  model_name?: string;
}

interface StubOptions {
  /** Map a /pii/extract request to the entities array it should return. */
  extract?: (req: ExtractRequest) => unknown;
  /** Return this exact top-level body object (to exercise bad shapes). */
  body?: unknown;
  /** Force a non-2xx status on /pii/extract. */
  status?: number;
  /** Return this exact (possibly non-JSON) raw body on /pii/extract. */
  raw?: string;
  /** Never respond to /pii/extract (to exercise the client timeout). */
  hang?: boolean;
  /** Status for GET /health (default 200). */
  health?: number;
}

const BODY = { surface: "body" } as const;

const ENV_KEYS = [
  "FICTA_PII_ENABLED",
  "FICTA_PII_BACKEND",
  "FICTA_PII_OPENMED_URL",
  "FICTA_PII_OPENMED_MODEL",
  "FICTA_PII_OPENMED_LANG",
  "FICTA_PII_OPENMED_SCORE_THRESHOLD",
  "FICTA_PII_OPENMED_ENTITIES",
  "FICTA_PII_OPENMED_TIMEOUT_MS",
] as const;

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

describe("openmed recognizer", () => {
  it("maps pii_entities to ProtectedValues, preferring the canonical label", async () => {
    const { result } = await withStub(
      {
        extract: () => [
          entity("John Smith", { label: "B-first_name", canonical_label: "PERSON", confidence: 0.92 }),
          entity("MRN-8675309", { label: "id_num", entity_type: "ID_NUM", confidence: 0.61 }),
        ],
      },
      () => openmedRecognizer.detect("Patient John Smith, MRN-8675309", BODY),
    );

    const byName = Object.fromEntries(result.map((v) => [v.name, v]));
    expect(byName.person).toMatchObject({
      value: "John Smith",
      source: "pii-openmed",
      kind: "pii",
      confidence: "high",
    });
    expect(byName.person).not.toHaveProperty("spans");
    expect(byName["id-num"]).toMatchObject({ value: "MRN-8675309", confidence: "probabilistic" });
  });

  it("sends OpenMed's strict schema fields and omits model_name unless configured", async () => {
    const { requests } = await withStub({ extract: () => [] }, () =>
      openmedRecognizer.detect("Patient John Smith", BODY),
    );
    expect(requests[0]).toMatchObject({ text: "Patient John Smith", confidence_threshold: 0.5, lang: "en" });
    expect(requests[0]).not.toHaveProperty("model_name");
    // OpenMed rejects unknown fields (extra="forbid") — never send Presidio's field names.
    expect(requests[0]).not.toHaveProperty("language");
    expect(requests[0]).not.toHaveProperty("score_threshold");

    process.env.FICTA_PII_OPENMED_MODEL = "OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1";
    const withModel = await withStub({ extract: () => [] }, () => openmedRecognizer.detect("John Smith", BODY));
    expect(withModel.requests[0]?.model_name).toBe("OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1");
  });

  it("drops below-threshold entities, short values, and duplicate values", async () => {
    const { result } = await withStub(
      {
        extract: () => [
          entity("John Smith", { confidence: 0.9 }), // kept
          entity("John Smith", { confidence: 0.9 }), // exact-value dupe → collapsed
          entity("Al", { confidence: 0.9 }), // too short
          entity("Jane Roe", { confidence: 0.2 }), // below default 0.5 threshold
        ],
      },
      () => openmedRecognizer.detect("John Smith met Al and Jane Roe", BODY),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("John Smith");
  });

  it("respects a configured entity allowlist client-side (matched against canonical labels)", async () => {
    process.env.FICTA_PII_OPENMED_ENTITIES = "PERSON";
    const { result } = await withStub(
      {
        extract: () => [
          entity("John Smith", { canonical_label: "PERSON", confidence: 0.9 }),
          entity("Springfield General", { canonical_label: "ORGANIZATION", confidence: 0.9 }),
        ],
      },
      () => openmedRecognizer.detect("John Smith at Springfield General", BODY),
    );
    expect(result.map((v) => v.value)).toEqual(["John Smith"]);
  });

  it("accepts a pii_entities envelope as a fallback for response-shape drift", async () => {
    const { result } = await withStub({ body: { pii_entities: [entity("John Smith", { confidence: 0.9 })] } }, () =>
      openmedRecognizer.detect("John Smith here", BODY),
    );
    expect(result.map((v) => v.value)).toEqual(["John Smith"]);
  });

  it("does not contact the sidecar for non-body surfaces", async () => {
    const { result, requests } = await withStub({ extract: () => [entity("John Smith", { confidence: 0.9 })] }, () =>
      openmedRecognizer.detect("John Smith", { surface: "header", header: "x-test" }),
    );
    expect(result).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("issues one /pii/extract call per chunk for oversized bodies and dedupes across chunks", async () => {
    const filler = "a\n".repeat(15_000); // ~30k chars → splits on newlines into >1 chunk
    const text = `${filler}find SECRETNAME here`;
    const { result, requests } = await withStub(
      {
        extract: (req) => (req.text.includes("SECRETNAME") ? [entity("SECRETNAME", { confidence: 0.9 })] : []),
      },
      () => openmedRecognizer.detect(text, BODY),
    );
    expect(requests.length).toBeGreaterThan(1);
    expect(result.map((v) => v.value)).toContain("SECRETNAME");
  });

  describe("failure taxonomy (fail-open is the plugin's job; the recognizer throws)", () => {
    it("throws unreachable when nothing is listening", async () => {
      const port = await closedPort();
      process.env.FICTA_PII_OPENMED_URL = `http://127.0.0.1:${port}`;
      await expect(openmedRecognizer.detect("John Smith here", BODY)).rejects.toMatchObject({
        reason: "unreachable",
      });
    });

    it("throws http_error on a non-2xx response", async () => {
      await expect(
        withStub({ status: 422 }, () => openmedRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "http_error", detail: "422" });
    });

    it("throws bad_response on non-JSON", async () => {
      await expect(
        withStub({ raw: "not json" }, () => openmedRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "bad_response" });
    });

    it("throws bad_response when the entities array is missing or malformed", async () => {
      await expect(
        withStub({ body: { results: [] } }, () => openmedRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "bad_response", detail: "expected entities array" });

      await expect(
        withStub({ extract: () => [{ label: "PERSON" }] }, () => openmedRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "bad_response", detail: "malformed entity" });
    });

    it("throws timeout within the configured budget when the sidecar hangs", async () => {
      process.env.FICTA_PII_OPENMED_TIMEOUT_MS = "100";
      const started = performance.now();
      await expect(
        withStub({ hang: true }, () => openmedRecognizer.detect("John Smith here", BODY)),
      ).rejects.toBeInstanceOf(OpenmedUnavailableError);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  });

  describe("checkOpenmedHealth", () => {
    it("reports ok when /health returns 200", async () => {
      const { server, port } = await start({ extract: () => [] });
      process.env.FICTA_PII_OPENMED_URL = `http://127.0.0.1:${port}`;
      try {
        expect(await checkOpenmedHealth()).toMatchObject({ ok: true });
      } finally {
        await close(server);
      }
    });

    it("reports not-ok (never throws) when the sidecar is down", async () => {
      const port = await closedPort();
      process.env.FICTA_PII_OPENMED_URL = `http://127.0.0.1:${port}`;
      const health = await checkOpenmedHealth();
      expect(health.ok).toBe(false);
      expect(health.detail).toBeTruthy();
    });
  });
});

// --- helpers ---------------------------------------------------------------

/** A pii_entities row in OpenMed's /pii/extract response shape. */
function entity(text: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { text, label: "PERSON", start: 0, end: text.length, ...extra };
}

function makeStub(opts: StubOptions): { server: Server; requests: ExtractRequest[] } {
  const requests: ExtractRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = opts.health ?? 200;
      res.end("ok");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (opts.hang) return; // never respond
      const parsed = JSON.parse(body) as ExtractRequest;
      requests.push(parsed);
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
      const payload = opts.body ?? { entities: opts.extract ? opts.extract(parsed) : [] };
      res.end(JSON.stringify(payload));
    });
  });
  return { server, requests };
}

async function start(opts: StubOptions): Promise<{ server: Server; port: number; requests: ExtractRequest[] }> {
  const { server, requests } = makeStub(opts);
  const port = await listen(server);
  return { server, port, requests };
}

/** Run `fn` against a fresh stub, pointing the recognizer at it, and always tear the stub down. */
async function withStub<T>(
  opts: StubOptions,
  fn: () => Promise<T>,
): Promise<{ result: ProtectedValue[]; requests: ExtractRequest[]; value: T }> {
  const { server, port, requests } = await start(opts);
  process.env.FICTA_PII_OPENMED_URL = `http://127.0.0.1:${port}`;
  try {
    const value = await fn();
    return { result: value as ProtectedValue[], requests, value };
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
  server.closeAllConnections?.(); // release any hung sockets from the timeout test
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bind then release a port so a subsequent connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
