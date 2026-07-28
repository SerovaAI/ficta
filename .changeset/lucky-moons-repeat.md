---
"@serovaai/ficta": patch
---

Escape restored values by JSON depth in complete (non-delta) payloads. The OpenAI wires carry tool-call arguments as JSON text nested inside a JSON string, so a value restored there sits two string contexts deep, but the buffered response path and the SSE replay events (`response.completed`, `response.output_item.done`, `choices[].message.tool_calls[]`) escaped it once. A restored value containing a newline, `"`, or `\` produced a body that parsed while the tool call inside it did not — the buffered twin of the streamed-fragment corruption fixed previously. Anthropic payloads were unaffected: `tool_use.input` is a real object, not nested JSON text. Escaping is now chosen per occurrence position, so the same surrogate in both a tool argument and assistant text in one payload is escaped correctly in each.
