import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeMarkdownForDetection } from "../src/engine/plugins/pii/markdown.js";
import { flexibleOccurrences } from "../src/engine/vault.js";
import { type ProtectedValue, piiPlugin } from "../src/plugins/index.js";

const BODY = { surface: "body" } as const;

describe("normalizeMarkdownForDetection", () => {
  it("masks emphasis/heading/list/strike/escape formatting to spaces, length-preserving", () => {
    const raw = "### **VIVEN BHOWANI**\n- **Reviewed by** ~~Neil White~~ \\_\\_\\_\\_";
    const out = normalizeMarkdownForDetection(raw);
    expect(out.length).toBe(raw.length); // offsets stay 1:1 for Presidio's code-point slicing
    expect(out).not.toContain("*");
    expect(out).not.toContain("#");
    expect(out).not.toContain("~");
    expect(out).not.toContain("\\");
    // Entities remain as contiguous substrings so value-based redaction still finds them in the original.
    expect(out).toContain("VIVEN BHOWANI");
    expect(out).toContain("Neil White");
  });

  it("leaves content punctuation that appears inside real entities untouched", () => {
    const raw = "shareholder of **LSD Open (Pty) Ltd (South Africa)** and LSD Open FZCO (UAE)";
    const out = normalizeMarkdownForDetection(raw);
    expect(out).toContain("LSD Open (Pty) Ltd (South Africa)"); // parens, spaces preserved
    expect(out).toContain("LSD Open FZCO (UAE)");
    expect(out).not.toContain("**");
  });

  it("keeps a bolded whole entity as a substring of the original after trimming", () => {
    const raw = "**LSD LIMITED SEYCHELLES**";
    const out = normalizeMarkdownForDetection(raw);
    // A NER span over the masked text slices "LSD LIMITED SEYCHELLES" (± space edges); trimmed, it is a
    // substring of the raw text, so redaction on the original finds it.
    expect(raw).toContain(out.trim());
    expect(out.trim()).toBe("LSD LIMITED SEYCHELLES");
  });
});

describe("flexibleOccurrences", () => {
  const doc = "CFO Viven Bhowani signed; see **VIVEN BHOWANI** and viven\nbhowani in the annex.";

  it("finds every distinct case-form present when caseInsensitive", () => {
    const forms = flexibleOccurrences(doc, "Viven Bhowani", { caseInsensitive: true });
    expect(forms).toContain("Viven Bhowani");
    expect(forms).toContain("VIVEN BHOWANI");
    expect(forms).toContain("viven\nbhowani"); // whitespace-flex still applies (single line break)
  });

  it("is case-sensitive by default", () => {
    const forms = flexibleOccurrences(doc, "Viven Bhowani");
    expect(forms).toEqual(["Viven Bhowani"]);
  });

  it("does not bridge a paragraph break (mirrors the redaction matcher)", () => {
    expect(flexibleOccurrences("Viven\n\nBhowani", "Viven Bhowani", { caseInsensitive: true })).toEqual([]);
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
    const body = "Represented by Viven Bhowani.\n### **VIVEN BHOWANI**\nAlso shareholder LSD Open (Pty) Ltd.";
    let sawText = "";
    const { server, port } = await startAnalyzeStub((req) => {
      sawText = req.text;
      // Presidio detects the title-case form (as spaCy would in clean prose). Return its span.
      const start = req.text.indexOf("Viven Bhowani");
      return start === -1 ? [] : [{ entity_type: "PERSON", start, end: start + "Viven Bhowani".length, score: 0.95 }];
    });

    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    try {
      const detected = (await piiPlugin.detectText?.(body, BODY)) as ProtectedValue[];
      const values = detected.map((v) => v.value);

      // NER saw Markdown-normalized text (no `**`/`#`), which is why the heading name is detectable.
      expect(sawText).not.toContain("**");
      expect(sawText).not.toContain("#");
      // The detected title-case entity AND its ALL-CAPS twin (present in the doc) are both covered.
      expect(values).toContain("Viven Bhowani");
      expect(values).toContain("VIVEN BHOWANI");
      // The ALL-CAPS form carries the same category as the detection it was expanded from.
      const expanded = detected.find((v) => v.value === "VIVEN BHOWANI");
      expect(expanded).toMatchObject({ name: "person", kind: "pii" });
      expect(expanded).not.toHaveProperty("spans");
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
      const detected = (await piiPlugin.detectText?.(body, BODY)) as ProtectedValue[];
      const values = detected.map((value) => value.value);
      expect(values).toContain("Will");
      expect(values).toContain("WILL");
      expect(values).not.toContain("will");
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
