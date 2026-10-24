import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin } from "../src/index.js";

const KEY = `${"k".repeat(16)}abcdefghijklmnopqrstuvwxyz0123456789`;
// Characters JSON escapes: a quote, a backslash, and a newline (a multi-line key).
const PASSWORD = 'Tr0ub4dor\\q7Zx"wV';
const PEM = "line-one-9fK2mQ\nline-two-4hT8pL";

function engine(): ProtectionEngine {
  return new ProtectionEngine({
    config: { surrogate: { key: KEY }, detectors: { secretShapes: false, pii: false } },
    plugins: [],
    values: [
      { name: "DB_PASSWORD", value: PASSWORD, source: ".env", kind: "secret", confidence: "exact" },
      { name: "SERVICE_KEY", value: PEM, source: ".env", kind: "secret", confidence: "exact" },
    ],
  });
}

const chatToolCall = (args: unknown, spacing?: number) =>
  JSON.stringify({
    messages: [
      { role: "user", content: "deploy" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", type: "function", function: { name: "shell", arguments: JSON.stringify(args, null, spacing) } },
        ],
      },
    ],
  });

function argumentsOf(body: string): string {
  return JSON.parse(body).messages[1].tool_calls[0].function.arguments as string;
}

describe("values inside tool-call JSON text", () => {
  it("redacts a registered value that JSON-escapes inside chat tool-call arguments", async () => {
    const result = await engine()
      .beginRequest()
      .redactBodyDetailed(chatToolCall({ cmd: `deploy --as '${PASSWORD}'`, key: PEM }));
    expect(result.leaks).toBe(0);
    expect(result.count).toBe(2);
    expect(result.body).not.toContain("q7Zx");
    expect(result.body).not.toContain("9fK2mQ");
    const args = JSON.parse(argumentsOf(result.body));
    expect(args.cmd).toMatch(/^deploy --as 'FICTA_[0-9a-f]{32}'$/);
    expect(args.key).toMatch(/^FICTA_[0-9a-f]{32}$/);
  });

  it("redacts inside Responses function_call arguments", async () => {
    const body = JSON.stringify({
      input: [
        {
          type: "function_call",
          name: "shell",
          call_id: "c1",
          arguments: JSON.stringify({ command: ["bash", "-lc", `cat > k <<EOF\n${PEM}\nEOF`] }),
        },
      ],
    });
    const result = await engine().beginRequest().redactBodyDetailed(body);
    expect(result.leaks).toBe(0);
    expect(result.body).not.toContain("9fK2mQ");
    expect(result.body).not.toContain("4hT8pL");
  });

  it("keeps every other byte of the arguments text, including formatting and large integers", async () => {
    const raw = (cmd: string) => `{\n  "note": "unchanged \\u00e9",\n  "cmd": ${cmd},\n  "n": 12345678901234567890\n}`;
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "shell", arguments: raw(JSON.stringify(`use ${PASSWORD}`)) },
            },
          ],
        },
      ],
    });
    const result = await engine().beginRequest().redactBodyDetailed(body);
    const args = JSON.parse(result.body).messages[0].tool_calls[0].function.arguments as string;
    expect(args.replace(/FICTA_[0-9a-f]{32}/, "TOKEN")).toBe(raw('"use TOKEN"'));
  });

  it("still detects a value written as a JSON number inside the arguments", async () => {
    const CARD = "4111111111111111";
    const cardDetector: DetectorPlugin = {
      kind: "detector",
      name: "fixture-card-detector",
      detectText: (text) =>
        text.includes(CARD)
          ? [
              {
                name: "card",
                value: CARD,
                source: "fixture-detector",
                kind: "pii" as const,
                confidence: "high" as const,
              },
            ]
          : [],
    };
    const eng = new ProtectionEngine({
      config: { surrogate: { key: KEY }, detectors: { secretShapes: false, pii: false } },
      plugins: [cardDetector],
    });
    const body = JSON.stringify({ input: [{ type: "function_call", arguments: `{"card": ${CARD}, "n": 7}` }] });
    const result = await eng.beginRequest().redactBodyDetailed(body);
    expect(result.body).not.toContain(CARD);
    const args = JSON.parse(JSON.parse(result.body).input[0].arguments as string);
    expect(args.card).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(args.n).toBe(7);
  });

  it("leaves arguments that are not JSON text to the plain scan", async () => {
    const body = JSON.stringify({ input: [{ type: "function_call", arguments: `not json ${PASSWORD}` }] });
    const result = await engine().beginRequest().redactBodyDetailed(body);
    expect(result.leaks).toBe(0);
    expect(result.body).not.toContain("q7Zx");
  });

  it("restores the arguments into a tool call that still parses, under restore_into_tools=all", async () => {
    const eng = new ProtectionEngine({
      config: {
        surrogate: { key: KEY },
        detectors: { secretShapes: false, pii: false },
        restore: { intoTools: "all" },
      },
      plugins: [],
      values: [{ name: "DB_PASSWORD", value: PASSWORD, source: ".env", kind: "secret", confidence: "exact" }],
    });
    const scope = eng.beginRequest();
    const redacted = await scope.redactBodyDetailed(chatToolCall({ cmd: `use ${PASSWORD}` }));
    const response = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              { id: "2", type: "function", function: { name: "shell", arguments: argumentsOf(redacted.body) } },
            ],
          },
        },
      ],
    });
    const restored = JSON.parse(scope.restoreJson(response, "openai-chat"));
    expect(JSON.parse(restored.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      cmd: `use ${PASSWORD}`,
    });
  });
});
