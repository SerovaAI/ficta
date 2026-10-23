import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { RestoreIntoToolsPolicy } from "../src/index.js";
import type { DetectorPlugin } from "../src/index.js";

const KEY = `${"k".repeat(16)}abcdefghijklmnopqrstuvwxyz0123456789`;
const SECRET = "regsecret-Hq4vT9mZ2c";
// A detected value with a newline: restored into a freeform tool it must stay a real newline.
const ADDRESS = "12 Example Street\nCape Town";
const SURROGATE = /FICTA_[0-9a-f]{32}/g;

const addressDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-address-detector",
  detectText: (text) =>
    text.includes(ADDRESS)
      ? [
          {
            name: "address",
            value: ADDRESS,
            source: "fixture-detector",
            kind: "pii" as const,
            confidence: "high" as const,
          },
        ]
      : [],
};

async function scopeWithTokens(intoTools: RestoreIntoToolsPolicy = "detected") {
  const engine = new ProtectionEngine({
    config: { surrogate: { key: KEY }, detectors: { secretShapes: false, pii: false }, restore: { intoTools } },
    plugins: [addressDetector],
    values: [{ name: "API_TOKEN", value: SECRET, source: ".env", kind: "secret", confidence: "exact" }],
  });
  const scope = engine.beginRequest();
  const redacted = await scope.redactBodyDetailed(JSON.stringify({ input: [`token ${SECRET}`, `ship to ${ADDRESS}`] }));
  const [secretLine, addressLine] = JSON.parse(redacted.body).input as string[];
  const secret = secretLine?.match(SURROGATE)?.[0] ?? "";
  const address = addressLine?.match(SURROGATE)?.[0] ?? "";
  expect(secret).not.toBe("");
  expect(address).not.toBe("");
  return { scope, secret, address };
}

async function restoreSse(
  scope: Awaited<ReturnType<typeof scopeWithTokens>>["scope"],
  events: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const sse = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const out = await new Response(
    new Blob([sse]).stream().pipeThrough(scope.restoreEventStream("openai-responses")),
  ).text();
  return out
    .split("\n\n")
    .map((record) => record.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("Codex freeform tools follow restore_into_tools", () => {
  it("withholds a registry secret from buffered custom_tool_call and local_shell_call", async () => {
    const { scope, secret, address } = await scopeWithTokens();
    const body = JSON.stringify({
      output: [
        { type: "custom_tool_call", name: "apply_patch", input: `*** Add File: x\n+${secret}\n+${address}` },
        { type: "local_shell_call", action: { type: "exec", command: ["bash", "-lc", `echo ${secret}`] } },
      ],
    });
    const restored = JSON.parse(scope.restoreJson(body, "openai-responses"));
    expect(JSON.stringify(restored)).not.toContain(SECRET);
    expect(restored.output[0].input).toBe(`*** Add File: x\n+${secret}\n+${ADDRESS}`);
    expect(restored.output[1].action.command[2]).toBe(`echo ${secret}`);
    expect(scope.withheldFromToolsCount).toBe(1);
  });

  it("withholds a registry secret split across custom_tool_call_input deltas, and from the done event", async () => {
    const { scope, secret, address } = await scopeWithTokens();
    const input = `+${secret}\n+${address}`;
    const cut = input.indexOf(secret) + 9;
    const events = await restoreSse(scope, [
      { type: "response.custom_tool_call_input.delta", item_id: "b", delta: input.slice(0, cut) },
      { type: "response.custom_tool_call_input.delta", item_id: "b", delta: input.slice(cut) },
      { type: "response.custom_tool_call_input.done", item_id: "b", input },
      { type: "response.output_item.done", item: { type: "custom_tool_call", id: "b", input } },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    const streamed = events
      .filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => event.delta)
      .join("");
    const expected = `+${secret}\n+${ADDRESS}`;
    expect(streamed).toBe(expected);
    expect(events.find((event) => event.type === "response.custom_tool_call_input.done")?.input).toBe(expected);
    expect(events.at(-1)?.item).toMatchObject({ input: expected });
  });

  it("withholds a registry secret from the function_call_arguments.done replay", async () => {
    const { scope, secret } = await scopeWithTokens();
    const args = JSON.stringify({ cmd: `curl -H 'auth: ${secret}'` });
    const events = await restoreSse(scope, [
      { type: "response.function_call_arguments.delta", item_id: "a", delta: args },
      { type: "response.function_call_arguments.done", item_id: "a", arguments: args },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[1]?.arguments).toBe(args);
  });

  it("restores everything under restore_into_tools=all", async () => {
    const { scope, secret } = await scopeWithTokens("all");
    const events = await restoreSse(scope, [
      { type: "response.custom_tool_call_input.delta", item_id: "b", delta: `+${secret}` },
    ]);
    expect(events[0]?.delta).toBe(`+${SECRET}`);
  });

  it("withholds a registry secret from a buffered chat custom tool call", async () => {
    const { scope, secret } = await scopeWithTokens();
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [{ id: "1", type: "custom", custom: { name: "apply_patch", input: `+${secret}` } }],
          },
        },
      ],
    });
    expect(scope.restoreJson(body, "openai-chat")).not.toContain(SECRET);
  });
});
