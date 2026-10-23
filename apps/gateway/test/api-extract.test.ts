import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES } from "@/lib/file-attachments";
import { Route } from "@/routes/api/extract";

/**
 * Calls the real /api/extract handler (default `none` auth) against a stub sidecar. Uploads are
 * attacker-controllable, so the route must decide the type from the bytes and never hand the converter
 * anything but PDF or DOCX, under a name whose extension matches the bytes.
 */

type Seen = { filename?: string; contentType?: string };

let server: Server | undefined;
let seen: Seen[];
let savedUrl: string | undefined;

beforeEach(() => {
  seen = [];
  savedUrl = process.env.FICTA_DOC_CONVERTER_URL;
});

afterEach(async () => {
  if (savedUrl === undefined) delete process.env.FICTA_DOC_CONVERTER_URL;
  else process.env.FICTA_DOC_CONVERTER_URL = savedUrl;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stubSidecar(status = 200): Promise<void> {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("latin1");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const disposition = /filename="([^"]*)"/.exec(body)?.[1];
      const contentType = /\r\nContent-Type: ([^\r]*)\r\n\r\n/.exec(body)?.[1];
      seen.push({ filename: disposition, contentType });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { markdown: "# Converted" } : { detail: "nope" }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  process.env.FICTA_DOC_CONVERTER_URL = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const handler = (Route.options.server as { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } })
  .handlers.POST;

function upload(bytes: Uint8Array, name: string, type = "application/octet-stream", headers?: HeadersInit): Request {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  return new Request("http://gateway.test/api/extract", { method: "POST", body: form, headers });
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const PDF = bytesOf("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const WAV = bytesOf("RIFF\x24\x00\x00\x00WAVEfmt ");

describe("/api/extract", () => {
  it("converts a PDF and names it by what the bytes are", async () => {
    await stubSidecar();
    const res = await handler({ request: upload(PDF, "brief.PDF", "application/pdf") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ markdown: "# Converted", name: "brief.PDF" });
    expect(seen).toEqual([{ filename: "brief.pdf", contentType: "application/pdf" }]);
  });

  it("refuses audio named as a PDF without calling the converter", async () => {
    await stubSidecar();
    const res = await handler({ request: upload(WAV, "memo.pdf", "application/pdf") });
    expect(res.status).toBe(415);
    expect(seen).toEqual([]);
  });

  it("refuses a legacy .doc (OLE) container", async () => {
    await stubSidecar();
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect((await handler({ request: upload(ole, "old.doc", "application/msword") })).status).toBe(415);
    expect(seen).toEqual([]);
  });

  it("sends a ZIP container on as .docx whatever it was called", async () => {
    await stubSidecar();
    expect((await handler({ request: upload(ZIP, "sheet.xlsx") })).status).toBe(200);
    expect(seen[0]?.filename).toBe("sheet.docx");
  });

  it("maps the sidecar's 415/413 to the user's file, not an outage", async () => {
    await stubSidecar(415);
    expect((await handler({ request: upload(ZIP, "a.docx") })).status).toBe(415);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await stubSidecar(413);
    expect((await handler({ request: upload(ZIP, "a.docx") })).status).toBe(413);
  });

  it("refuses an oversized declared body before parsing it", async () => {
    await stubSidecar();
    const request = upload(PDF, "big.pdf", "application/pdf", {
      "content-length": String(MAX_DOCUMENT_BYTES + 1024 * 1024),
    });
    expect((await handler({ request })).status).toBe(413);
    expect(seen).toEqual([]);
  });
});
