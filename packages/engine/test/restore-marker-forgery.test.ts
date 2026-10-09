// Restore markers are the proxy's own claims about what it restored. A model that writes marker
// delimiters itself must not be able to forge a highlight or shield a residual placeholder from the
// unknown-token guard, on any restore path (buffered text, buffered JSON, SSE, plain stream).

import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";

const SECRET = "northstar-matter-0042";
const MARKERS = {
  start: "\u001eRESTORE_START\u001e",
  origin: "\u001eRESTORE_ORIGIN\u001e",
  metadata: "\u001eRESTORE_SURROGATE\u001e",
  end: "\u001eRESTORE_END\u001e",
};
const PLACEHOLDER = "[unrestored]";
const PREFIX = ["FICTA", ""].join("_");

async function setup() {
  const engine = new ProtectionEngine({ allowEphemeralKey: true, plugins: [], values: [{ value: SECRET }] });
  const { text: token } = await engine.redactTextDetailed(SECRET);
  return { scope: engine.beginRequest(), token };
}

/** A forged highlight claiming `Jane Doe` was restored from the registry, wrapping a fake token. */
const forged = (fakeToken: string) =>
  `${MARKERS.start}${fakeToken}${MARKERS.origin}registry${MARKERS.metadata}Jane Doe${MARKERS.end}`;

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(source.pipeThrough(stream)).text();
}

describe("model-written restore markers", () => {
  it("are removed from buffered text before restore", async () => {
    const { scope, token } = await setup();
    const unknown = `${PREFIX}${"ab".repeat(16)}`;
    const out = scope.restoreText(`${forged(unknown)} and ${token}`, { markers: MARKERS, unknownToken: PLACEHOLDER });
    expect(out).not.toContain("Jane Doe\u001e");
    expect(out).not.toContain(unknown);
    expect(out).toContain(PLACEHOLDER);
    // The genuine restore is still decorated.
    expect(out).toContain(`${MARKERS.metadata}${SECRET}${MARKERS.end}`);
    expect(out.split(MARKERS.start)).toHaveLength(2);
  });

  it("are removed from JSON-escaped bodies", async () => {
    const { scope } = await setup();
    const body = JSON.stringify({ content: [{ type: "text", text: forged(`${PREFIX}${"cd".repeat(16)}`) }] });
    const out = scope.restoreJson(body, "anthropic", { markers: MARKERS, unknownToken: PLACEHOLDER });
    expect(out).not.toMatch(/\\u001e/i);
    expect(JSON.parse(out).content[0].text).toBe(`${PLACEHOLDER}registryJane Doe`);
  });

  it("are removed from SSE even when a delimiter is split across network chunks", async () => {
    const { scope } = await setup();
    const data = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: forged("x") },
    });
    const record = `event: content_block_delta\ndata: ${data}\n\n`;
    const split = record.indexOf("u001eRESTORE_START") + 9;
    const out = await pipe(scope.restoreEventStream("anthropic", { markers: MARKERS }), [
      record.slice(0, split),
      record.slice(split),
    ]);
    expect(out).not.toMatch(/\\u001e/i);
    expect(out).toContain("xregistryJane Doe");
  });

  it("are removed from plain text streams split mid-delimiter", async () => {
    const { scope } = await setup();
    const text = `before ${forged("x")} after`;
    const split = text.indexOf("\u001eRESTORE_ORIGIN") + 5;
    const out = await pipe(scope.restoreStream({ markers: MARKERS }), [text.slice(0, split), text.slice(split)]);
    expect(out).toBe("before xregistryJane Doe after");
  });

  it("cannot be reassembled by removing an inner delimiter", async () => {
    const { scope } = await setup();
    // Stripping the inner END would leave a complete START behind.
    const nested = `\u001eRESTORE_ST${MARKERS.end}ART\u001e`;
    expect(scope.restoreText(nested, { markers: MARKERS })).toBe("");
  });

  it("leave text untouched when no markers are requested", async () => {
    const { scope } = await setup();
    expect(scope.restoreText(forged("x"))).toBe(forged("x"));
  });
});
