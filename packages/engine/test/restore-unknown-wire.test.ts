import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import { surrogateStrategy } from "../src/surrogate.js";
import { Vault } from "../src/vault.js";
import { sseRestoreAdapterFor } from "../src/wire-restore.js";
import type { Wire } from "../src/wire.js";

const SECRET = "registered-example-value";
const OPTIONS = { unknownToken: "[unrestored reference]" };
function setup() {
  const engine = new ProtectionEngine({
    values: [{ name: "example", value: SECRET }],
    plugins: [],
    allowEphemeralKey: true,
  });
  return engine.beginRequest();
}
async function stream(chunks: string[], transform: TransformStream<Uint8Array, Uint8Array>) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }).pipeThrough(transform),
  ).text();
}
const mutations = [
  (token: string) => token.slice(0, -1),
  (token: string) => token.toLowerCase(),
  (token: string) => token.slice(0, -16) + " " + token.slice(-16),
  (token: string) => token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"),
];
function delta(wire: Wire, text: string) {
  const data =
    wire === "anthropic"
      ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
      : wire === "openai-chat"
        ? { choices: [{ index: 0, delta: { content: text } }] }
        : { type: "response.output_text.delta", item_id: "item", content_index: 0, delta: text };
  return `data: ${JSON.stringify(data)}\n\n`;
}
function textIn(wire: Wire, output: string) {
  return output
    .split("\n\n")
    .filter((record) => record.includes("data: {"))
    .map((record) => {
      const data = JSON.parse(record.slice(record.indexOf("data: ") + 6));
      return wire === "anthropic"
        ? data.delta.text
        : wire === "openai-chat"
          ? data.choices[0].delta.content
          : data.delta;
    })
    .join("");
}

describe("opt-in unknown references on wire restores", () => {
  for (const [index, mutate] of mutations.entries()) {
    it(`reassembles mutation ${index} at every plain-stream boundary before replacing it`, async () => {
      const seed = setup();
      const token = (await seed.redactContentDetailed(SECRET)).text;
      const bad = mutate(token);
      for (let cut = 1; cut < bad.length; cut++) {
        const scope = setup();
        await scope.redactContentDetailed(SECRET);
        const out = await stream(["start " + bad.slice(0, cut), bad.slice(cut) + " end"], scope.restoreStream(OPTIONS));
        expect(out).toBe("start [unrestored reference] end");
        expect(scope.residualSurrogateCount).toBe(1);
      }
    });
    for (const wire of ["anthropic", "openai-chat", "openai-responses"] as const) {
      it(`reassembles mutation ${index} on ${wire} at every SSE-fragment boundary`, async () => {
        const seed = setup();
        const token = (await seed.redactContentDetailed(SECRET)).text;
        const bad = mutate(token);
        for (let cut = 1; cut < bad.length; cut++) {
          const scope = setup();
          await scope.redactContentDetailed(SECRET);
          const out = await stream(
            [delta(wire, "start " + bad.slice(0, cut)), delta(wire, bad.slice(cut)), "data: [DONE]\n\n"],
            scope.restoreEventStream(wire, OPTIONS),
          );
          expect(textIn(wire, out)).toBe("start [unrestored reference]");
          expect(scope.residualSurrogateCount).toBe(1);
        }
      });
    }
  }
  it("preserves mapped tokens withheld from buffered and streamed tool arguments", async () => {
    const scope = setup();
    const token = (await scope.redactContentDetailed(SECRET)).text;
    const bad = mutations[3]!(token);
    const argumentsText = JSON.stringify({ known: token, unknown: bad });
    const body = JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { arguments: argumentsText } }] } }],
    });
    const restored = JSON.parse(scope.restoreJson(body, "openai-chat", OPTIONS));
    expect(JSON.parse(restored.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      known: token,
      unknown: OPTIONS.unknownToken,
    });
    expect(scope.withheldFromToolsCount).toBe(1);
  });
  it("retains tool withholding when an intact token is held until the end of an SSE stream", async () => {
    const scope = setup();
    const token = (await scope.redactContentDetailed(SECRET)).text;
    const event = (argumentsText: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText } }] } }] })}\n\n`;
    const out = await stream(
      [event(token.slice(0, 13)), event(token.slice(13)), "data: [DONE]\n\n"],
      scope.restoreEventStream("openai-chat", OPTIONS),
    );
    const argumentsText = out
      .split("\n\n")
      .filter((record) => record.startsWith("data: {"))
      .map((record) => JSON.parse(record.slice(6)).choices[0].delta.tool_calls[0].function.arguments)
      .join("");
    expect(argumentsText).toBe(token);
    expect(argumentsText).not.toContain(SECRET);
    expect(scope.withheldFromToolsCount).toBe(1);
    expect(scope.residualSurrogateCount).toBe(0);
  });
  it("escapes replacement inside nested tool JSON even when every reference is mutated", async () => {
    const scope = setup();
    const token = (await scope.redactContentDetailed(SECRET)).text;
    const body = JSON.stringify({
      choices: [
        { message: { tool_calls: [{ function: { arguments: JSON.stringify({ value: token.slice(0, -1) }) } }] } },
      ],
    });
    const restored = JSON.parse(scope.restoreJson(body, "openai-chat", { unknownToken: 'unknown "reference"' }));
    expect(JSON.parse(restored.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      value: 'unknown "reference"',
    });
  });
  it("keeps buffered JSON numbers intact and escapes a caller's replacement", () => {
    const scope = setup();
    const token = ["FICTA", ""].join("_") + "ab".repeat(16);
    const body = `{ "number": 9007199254740993, "text": "${token}" }`;
    expect(scope.restoreJson(body, "unknown", { unknownToken: 'unknown "reference"' })).toBe(
      '{ "number": 9007199254740993, "text": "unknown \\"reference\\"" }',
    );
  });
  it("does not sanitize token-like characters inside restored values", async () => {
    const raw = "literal " + ["FICTA", ""].join("_") + "ab".repeat(16);
    const strategy = surrogateStrategy();
    const vault = new Vault([{ value: raw }], strategy);
    const token = strategy.mint(raw);
    expect(vault.restoreText(token, OPTIONS)).toBe(raw);
    expect(JSON.parse(vault.restoreJson(JSON.stringify({ text: token }), undefined, OPTIONS)).text).toBe(raw);
  });
  for (const wire of ["anthropic", "openai-chat", "openai-responses"] as const) {
    it(`preserves token-like literals in restored ${wire} fragments`, async () => {
      const raw = "literal " + ["FICTA", ""].join("_") + "ab".repeat(16);
      const strategy = surrogateStrategy();
      const vault = new Vault([{ value: raw }], strategy);
      const token = strategy.mint(raw);
      const out = await stream(
        [delta(wire, token + "."), "data: [DONE]\n\n"],
        vault.restoreEventStream(sseRestoreAdapterFor(wire), undefined, OPTIONS),
      );
      expect(textIn(wire, out)).toBe(raw + ".");
    });
  }
  it("restores sibling fields separately from already-restored fragments", async () => {
    const scope = setup();
    const token = (await scope.redactContentDetailed(SECRET)).text;
    const event = { choices: [{ index: 0, delta: { content: token + ".", reasoning_content: token } }] };
    const out = await stream([`data: ${JSON.stringify(event)}\n\n`], scope.restoreEventStream("openai-chat", OPTIONS));
    const restored = JSON.parse(out.slice(6));
    expect(restored.choices[0].delta).toEqual({ content: SECRET + ".", reasoning_content: SECRET });
  });
  it("leaves unknown references unchanged unless opted in", async () => {
    const scope = setup();
    const token = (await scope.redactContentDetailed(SECRET)).text;
    const bad = mutations[3]!(token);
    expect(scope.restoreText(bad)).toBe(bad);
    expect(await stream([bad], scope.restoreStream())).toBe(bad);
  });
});
