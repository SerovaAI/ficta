import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { normalizeMarkdownForDetection } from "../src/engine/plugins/pii/markdown.js";
import { flexibleOccurrences } from "../src/engine/vault.js";
import { piiPlugin } from "../src/plugins/index.js";

describe("normalizeMarkdownForDetection", () => {
  it("removes emphasis/heading/list/strike/escape formatting and maps offsets back to raw text", () => {
    const raw = "### **AVERY EXAMPLE**\n- **Reviewed by** ~~Neil White~~ \\_\\_\\_\\_";
    const view = normalizeMarkdownForDetection(raw);
    const out = view.text;
    expect(out.length).toBeLessThan(raw.length);
    expect(out).not.toContain("*");
    expect(out).not.toContain("#");
    expect(out).not.toContain("~");
    expect(out).not.toContain("\\");
    // Entities remain as contiguous substrings so value-based redaction still finds them in the original.
    expect(out).toContain("AVERY EXAMPLE");
    expect(out).toContain("Neil White");
    const start = out.indexOf("AVERY EXAMPLE");
    const rawStart = view.toRaw(start, "start");
    const rawEnd = view.toRaw(start + "AVERY EXAMPLE".length, "end");
    expect(raw.slice(rawStart, rawEnd)).toBe("AVERY EXAMPLE");
  });

  it("leaves content punctuation that appears inside real entities untouched", () => {
    const raw = "shareholder of **Blue Lantern (Pty) Ltd (South Africa)** and Blue Lantern FZCO (UAE)";
    const out = normalizeMarkdownForDetection(raw).text;
    expect(out).toContain("Blue Lantern (Pty) Ltd (South Africa)"); // parens, spaces preserved
    expect(out).toContain("Blue Lantern FZCO (UAE)");
    expect(out).not.toContain("**");
  });

  it("keeps a bolded whole entity as a substring of the original after trimming", () => {
    const raw = "**BLUE LANTERN LIMITED SEYCHELLES**";
    const out = normalizeMarkdownForDetection(raw).text;
    // A NER span over the masked text slices "BLUE LANTERN LIMITED SEYCHELLES" (± space edges); trimmed, it is a
    // substring of the raw text, so redaction on the original finds it.
    expect(raw).toContain(out.trim());
    expect(out.trim()).toBe("BLUE LANTERN LIMITED SEYCHELLES");
  });

  it("closes internal-markdown gaps and maps the compact span back to raw text", () => {
    const raw = "Blue **Lantern** FZCO";
    const compact = normalizeMarkdownForDetection(raw);
    expect(compact.text).toBe("Blue Lantern FZCO");
    const start = compact.text.indexOf("Blue Lantern FZCO");
    expect(raw.slice(compact.toRaw(start, "start"), compact.toRaw(start + "Blue Lantern FZCO".length, "end"))).toBe(
      raw,
    );
  });
});

describe("flexibleOccurrences", () => {
  const doc = "CFO Avery Example signed; see **AVERY EXAMPLE** and avery\nexample in the annex.";

  it("finds every distinct case-form present when caseInsensitive", () => {
    const forms = flexibleOccurrences(doc, "Avery Example", { caseInsensitive: true });
    expect(forms).toContain("Avery Example");
    expect(forms).toContain("AVERY EXAMPLE");
    expect(forms).toContain("avery\nexample"); // whitespace-flex still applies (single line break)
  });

  it("is case-sensitive by default", () => {
    const forms = flexibleOccurrences(doc, "Avery Example");
    expect(forms).toEqual(["Avery Example"]);
  });

  it("does not bridge a paragraph break (mirrors the redaction matcher)", () => {
    expect(flexibleOccurrences("Avery\n\nExample", "Avery Example", { caseInsensitive: true })).toEqual([]);
  });

  it("can require token boundaries for word-like values", () => {
    const forms = flexibleOccurrences("Ann signed; ANN approved; ANNOUNCEMENT follows.", "Ann", {
      caseInsensitive: true,
      wordBounded: true,
    });
    expect(forms).toEqual(["Ann", "ANN"]);
  });
});

describe("piiPlugin.detectText — markdown + case coverage", () => {
  const ENV_KEYS = ["FICTA_PII_ENABLED", "FICTA_PII_BACKEND", "FICTA_PII_PRESIDIO_URL"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("feeds NER normalized text and recovers the ALL-CAPS twin of a title-case detection", async () => {
    // Body has the name in title-case prose and ALL-CAPS bold heading — the class that leaked upstream.
    const body = "Represented by Avery Example.\n### **AVERY EXAMPLE**\nAlso shareholder Blue Lantern (Pty) Ltd.";
    let sawText = "";
    const { server, port } = await startAnalyzeStub((req) => {
      sawText = req.text;
      // Presidio detects the title-case form (as spaCy would in clean prose). Return its span.
      const start = req.text.indexOf("Avery Example");
      return start === -1 ? [] : [{ entity_type: "PERSON", start, end: start + "Avery Example".length, score: 0.95 }];
    });

    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: body }));

      // NER saw Markdown-normalized text (no `**`/`#`), which is why the heading name is detectable.
      expect(sawText).not.toContain("**");
      expect(sawText).not.toContain("#");
      expect(redacted.body).not.toContain("Avery Example");
      expect(redacted.body).not.toContain("AVERY EXAMPLE");
      expect(engine.restoreText(redacted.body)).toContain("AVERY EXAMPLE");
    } finally {
      await close(server);
    }
  });

  it("does not expand a title-cased single-token name into an ordinary lowercase word", async () => {
    const body = "Will Smith signed. We will proceed. WILL SMITH approved.";
    const { server, port } = await startAnalyzeStub((req) => {
      const start = req.text.indexOf("Will");
      return start === -1 ? [] : [{ entity_type: "PERSON", start, end: start + "Will".length, score: 0.95 }];
    });

    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: body }));
      expect(redacted.body).not.toContain("Will Smith");
      expect(redacted.body).not.toContain("WILL SMITH");
      expect(redacted.body).toContain("We will proceed");
    } finally {
      await close(server);
    }
  });

  it("preserves standalone person candidates contained in full names for occurrence resolution", async () => {
    const body = "Alice Example and Candice Sample signed. Alice and Candice will visit.";
    const { server, port } = await startAnalyzeStub((req) => {
      const spans = ["Alice Example", "Candice Sample", "Alice", "Candice"].flatMap((value, index) => {
        const from = index < 2 ? 0 : req.text.indexOf("signed.") + "signed.".length;
        const start = req.text.indexOf(value, from);
        return start === -1 ? [] : [{ entity_type: "PERSON", start, end: start + value.length, score: 0.95 }];
      });
      return spans;
    });
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: body }));
      expect(redacted.body).not.toContain("Alice");
      expect(redacted.body).not.toContain("Candice");
      expect(redacted.count).toBe(4);
      expect(redacted.hits).toHaveLength(4);
      expect(redacted.hits.every((hit) => hit.name === "person")).toBe(true);
      expect(redacted.leaks).toBe(0);
      expect(engine.restoreJson(redacted.body)).toContain(body);
    } finally {
      await close(server);
    }
  });

  it("maps a compact internal-Markdown NER span back to the exact raw body range", async () => {
    const party = "Blue Lantern FZCO";
    const body = "The counterparty is Blue **Lantern** FZCO.";
    let analyzerText = "";
    const { server, port } = await startAnalyzeStub((req) => {
      analyzerText = req.text;
      const start = req.text.indexOf(party);
      return start === -1 ? [] : [{ entity_type: "ORGANIZATION", start, end: start + party.length, score: 0.95 }];
    });
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: body }));
      expect(analyzerText).toContain(party);
      expect(redacted.body).not.toContain("Blue **Lantern** FZCO");
      expect(redacted.leaks).toBe(0);
      expect(engine.restoreJson(redacted.body)).toContain("Blue **Lantern** FZCO");
    } finally {
      await close(server);
    }
  });
});

interface AnalyzeRequest {
  text: string;
}

async function startAnalyzeStub(analyze: (req: AnalyzeRequest) => unknown): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const spans = analyze(JSON.parse(body) as AnalyzeRequest);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(spans));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
