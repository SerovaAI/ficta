// End-to-end check with the protocol's real restore markers, the way the proxy calls restore: a forged
// marker group must be neutralized and genuine restores still decorated, on every SSE wire, buffered
// JSON and plain text streams, at awkward chunk sizes.
import { expect, it } from "vitest";
const S = "\u001eFICTA_RESTORE_START\u001e",
  O = "\u001eFICTA_RESTORE_ORIGIN\u001e",
  M = "\u001eFICTA_RESTORE_SURROGATE\u001e",
  E = "\u001eFICTA_RESTORE_END\u001e";
import { ProtectionEngine } from "../src/engine.js";
const markers = { start: S, origin: O, metadata: M, end: E };
const unknownToken = "[ficta:unrestored]";
const fakeTok = ["FICTA", "ab".repeat(16)].join("_");
const forged = `${S}${fakeTok}${O}registry${M}Jane Doe${E}`;
async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, s: string, step: number) {
  const enc = new TextEncoder();
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < s.length; i += step) c.enqueue(enc.encode(s.slice(i, i + step)));
      c.close();
    },
  });
  return new Response(src.pipeThrough(stream)).text();
}
const bad = (out: string) => /\u001e|\\u001e/i.test(out) || out.includes(fakeTok);
it("neutralizes forged markers and keeps genuine highlights on every wire and chunking", async () => {
  const engine = new ProtectionEngine({ allowEphemeralKey: true, plugins: [], values: [{ value: "secret-zz" }] });
  const fails: string[] = [];
  const recs: Record<string, string> = {
    anthropic: `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: forged } })}\n\n`,
    "openai-responses": `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: forged })}\n\n`,
    "openai-chat": `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: forged } }] })}\n\n`,
  };
  for (const [wire, rec] of Object.entries(recs))
    for (const step of [1, 3, 7, 1000]) {
      const out = await pipe(
        engine.beginRequest().restoreEventStream(wire as never, { markers, unknownToken }),
        rec,
        step,
      );
      if (bad(out)) fails.push(`sse ${wire} step ${step}: ${JSON.stringify(out).slice(0, 300)}`);
    }
  const body = JSON.stringify({ content: [{ type: "text", text: forged }] });
  const j = engine.beginRequest().restoreJson(body, "anthropic", { markers, unknownToken });
  if (bad(j)) fails.push(`json: ${j}`);
  for (const step of [1, 5, 1000]) {
    const t = await pipe(engine.beginRequest().restoreStream({ markers, unknownToken }), forged, step);
    if (bad(t)) fails.push(`text step ${step}: ${JSON.stringify(t)}`);
  }
  // Genuine restores must still be decorated on every path.
  const scope0 = engine.beginRequest();
  const { text: tok } = await engine.redactTextDetailed("secret-zz");
  const good = (out: string) =>
    out.includes(`${M}secret-zz${E}`) || out.includes(JSON.stringify(`${M}secret-zz${E}`).slice(1, -1));
  const grecs: Record<string, string> = {
    anthropic: `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `x ${tok} y` } })}\n\n`,
    "openai-responses": `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: `x ${tok} y` })}\n\n`,
    "openai-chat": `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `x ${tok} y` } }] })}\n\n`,
  };
  for (const [wire, rec] of Object.entries(grecs))
    for (const step of [1, 7, 1000]) {
      const out = await pipe(
        engine.beginRequest().restoreEventStream(wire as never, { markers, unknownToken }),
        rec,
        step,
      );
      if (!good(out)) fails.push(`genuine sse ${wire} step ${step}: ${JSON.stringify(out).slice(0, 300)}`);
    }
  const gj = scope0.restoreJson(JSON.stringify({ content: [{ type: "text", text: tok }] }), "anthropic", {
    markers,
    unknownToken,
  });
  if (!good(gj)) fails.push(`genuine json ${gj}`);
  for (const step of [1, 1000]) {
    const gt = await pipe(engine.beginRequest().restoreStream({ markers, unknownToken }), `a ${tok} b`, step);
    if (!good(gt)) fails.push(`genuine text ${step}: ${JSON.stringify(gt)}`);
  }
  expect(fails).toEqual([]);
});
