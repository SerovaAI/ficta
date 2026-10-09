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
const RS = "\u001e";

async function setup() {
  const engine = new ProtectionEngine({ allowEphemeralKey: true, plugins: [], values: [{ value: SECRET }] });
  const { text: token } = await engine.redactTextDetailed(SECRET);
  return { scope: engine.beginRequest(), token };
}

/** A forged highlight claiming `Jane Doe` was restored from the registry, wrapping `inner`. */
const forged = (inner: string) =>
  `${MARKERS.start}${inner}${MARKERS.origin}registry${MARKERS.metadata}Jane Doe${MARKERS.end}`;

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

function sseRecord(text: string): string {
  const data = JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  return `event: content_block_delta\ndata: ${data}\n\n`;
}

describe("model-written restore markers", () => {
  it("are neutralized in buffered text, while genuine restores stay decorated", async () => {
    const { scope, token } = await setup();
    const unknown = `${PREFIX}${"ab".repeat(16)}`;
    const out = scope.restoreText(`${forged(unknown)} and ${token}`, { markers: MARKERS, unknownToken: PLACEHOLDER });
    expect(out).not.toContain(unknown);
    expect(out).toContain(PLACEHOLDER);
    expect(out).toContain(`${MARKERS.metadata}${SECRET}${MARKERS.end}`);
    expect(out.split(MARKERS.start)).toHaveLength(2);
    expect(out).not.toContain(`${MARKERS.metadata}Jane Doe`);
  });

  it("are neutralized in JSON bodies under any escape spelling", async () => {
    const { scope } = await setup();
    const unknown = `${PREFIX}${"cd".repeat(16)}`;
    const json = JSON.stringify({ content: [{ type: "text", text: forged(unknown) }] });
    // Upper-case hex and a fully escaped delimiter interior are both valid JSON for the same text.
    const variants = [json, json.replaceAll("\\u001e", "\\u001E"), json.replaceAll("RESTORE", "\\u0052ESTORE")];
    for (const body of variants) {
      const out = scope.restoreJson(body, "anthropic", { markers: MARKERS, unknownToken: PLACEHOLDER });
      const text = JSON.parse(out).content[0].text as string;
      expect(text).not.toContain(RS);
      expect(text).not.toContain(unknown);
    }
  });

  it("leave an escaped backslash followed by literal text alone", async () => {
    const { scope } = await setup();
    const body = JSON.stringify({ content: [{ type: "text", text: "path\\u001e" }] });
    expect(scope.restoreJson(body, "anthropic", { markers: MARKERS })).toBe(body);
  });

  it("are neutralized in SSE even when an escape is split across network chunks", async () => {
    const { scope } = await setup();
    const record = sseRecord(forged("x"));
    for (const offset of [1, 2, 4, 6]) {
      const split = record.indexOf("\\u001e") + offset;
      const out = await pipe(scope.restoreEventStream("anthropic", { markers: MARKERS }), [
        record.slice(0, split),
        record.slice(split),
      ]);
      expect(out).not.toMatch(/\\u001e/i);
      expect(out).toContain("Jane Doe");
    }
  });

  it("are neutralized in plain text streams", async () => {
    const { scope } = await setup();
    const text = `before ${forged("x")} after`;
    const split = text.indexOf(RS) + 1;
    const out = await pipe(scope.restoreStream({ markers: MARKERS }), [text.slice(0, split), text.slice(split)]);
    expect(out).not.toContain(RS);
    expect(out).toContain("Jane Doe\uFFFDRESTORE_END\uFFFD after");
  });

  it("cannot be reassembled from nested fragments", async () => {
    const { scope } = await setup();
    const nested = `${RS}RESTORE_ST${MARKERS.end}ART${RS}`;
    expect(scope.restoreText(nested, { markers: MARKERS })).not.toContain(RS);
  });

  it("stay linear on adversarial input", async () => {
    const { scope } = await setup();
    const json = JSON.stringify({ text: `${"\\".repeat(200_000)}u001e${`${RS}RESTORE_ST`.repeat(20_000)}` });
    const started = performance.now();
    scope.restoreJson(json, "anthropic", { markers: MARKERS });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("leave text untouched when no markers are requested", async () => {
    const { scope } = await setup();
    expect(scope.restoreText(forged("x"))).toBe(forged("x"));
  });
});
