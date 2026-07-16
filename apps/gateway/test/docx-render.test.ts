import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RENDER_MARKDOWN_BYTES, safeDocxFilename } from "@/lib/documents/render";
import { DocumentRendererUnavailableError, getRenderer } from "@/lib/documents/renderer.server";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("safeDocxFilename", () => {
  it("defaults when the name is missing or blank", () => {
    expect(safeDocxFilename(undefined)).toBe("document.docx");
    expect(safeDocxFilename(null)).toBe("document.docx");
    expect(safeDocxFilename("   ")).toBe("document.docx");
  });

  it("forces a .docx extension exactly once", () => {
    expect(safeDocxFilename("contract")).toBe("contract.docx");
    expect(safeDocxFilename("contract.DOCX")).toBe("contract.docx");
    expect(safeDocxFilename("contract.pdf")).toBe("contract.pdf.docx");
  });

  it("strips directory components on both separators", () => {
    expect(safeDocxFilename("../../etc/passwd")).toBe("passwd.docx");
    expect(safeDocxFilename("a/b/contract.docx")).toBe("contract.docx");
    expect(safeDocxFilename("..\\..\\contract.docx")).toBe("contract.docx");
  });

  it("replaces header-unsafe characters", () => {
    expect(safeDocxFilename('x"\r\n: evil.docx')).toBe("x_ evil.docx");
    expect(safeDocxFilename("...docx")).toBe("document.docx");
  });

  it("keeps reasonable titles intact", () => {
    expect(safeDocxFilename("Consulting Agreement (v2).docx")).toBe("Consulting Agreement (v2).docx");
  });

  it("bounds an unreasonably long name", () => {
    const name = safeDocxFilename(`${"A".repeat(500)}.docx`);
    expect(name).toBe(`${"A".repeat(120)}.docx`);
  });
});

describe("MAX_RENDER_MARKDOWN_BYTES", () => {
  it("is generous enough for a very long contract", () => {
    expect(MAX_RENDER_MARKDOWN_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

describe("restDocumentRenderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
    const mock = vi.fn(impl);
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("posts markdown and returns the docx bytes", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const mock = stubFetch(
      async () => new Response(docx, { status: 200, headers: { "content-type": DOCX_CONTENT_TYPE } }),
    );

    const result = await getRenderer().toDocx({ markdown: "# Hi", filename: "a.docx" });
    expect(result.bytes).toEqual(docx);

    const [url, init] = mock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/render$/);
    expect(JSON.parse(String(init?.body))).toEqual({ markdown: "# Hi", filename: "a.docx" });
  });

  it("maps a connection failure to `unreachable`", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getRenderer().toDocx({ markdown: "# Hi" })).rejects.toMatchObject({
      name: "DocumentRendererUnavailableError",
      reason: "unreachable",
    });
  });

  it("maps an abort to `timeout`", async () => {
    stubFetch(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(getRenderer().toDocx({ markdown: "# Hi" })).rejects.toMatchObject({ reason: "timeout" });
  });

  it("maps a non-2xx sidecar response to `http_error` with the status as detail", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    const err = await getRenderer()
      .toDocx({ markdown: "# Hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRendererUnavailableError);
    expect(err).toMatchObject({ reason: "http_error", detail: "500" });
  });

  it("rejects a non-docx content type as `bad_response`", async () => {
    stubFetch(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(getRenderer().toDocx({ markdown: "# Hi" })).rejects.toMatchObject({ reason: "bad_response" });
  });

  it("rejects an empty body as `bad_response`", async () => {
    stubFetch(
      async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": DOCX_CONTENT_TYPE } }),
    );
    await expect(getRenderer().toDocx({ markdown: "# Hi" })).rejects.toMatchObject({ reason: "bad_response" });
  });
});
