import { isRecord } from "./json.js";
import {
  type BufferedRestoreAdapter,
  NOOP_BUFFERED_RESTORE_ADAPTER,
  type SseRestoreAdapter,
  type StreamingTextFragment,
} from "./vault.js";
import type { Wire } from "./wire.js";

/**
 * Per-provider knowledge for the vault's generic SSE restore: which streamed fields carry
 * incremental text/tool-call fragments to reassemble, and which events end a logical block so a
 * held partial surrogate can be flushed. The vault stays provider-agnostic; this module owns the
 * Anthropic / OpenAI wire schemas, keyed off the request-path `Wire`.
 */
export function sseRestoreAdapterFor(wire: Wire): SseRestoreAdapter {
  switch (wire) {
    case "anthropic":
      return ANTHROPIC_ADAPTER;
    case "openai-chat":
      return OPENAI_CHAT_ADAPTER;
    case "openai-responses":
      return OPENAI_RESPONSES_ADAPTER;
    default:
      return NOOP_ADAPTER;
  }
}

const NOOP_ADAPTER: SseRestoreAdapter = {
  fragments: () => [],
  stopPrefixes: () => [],
};

/**
 * Per-provider knowledge for the vault's buffered restore and for full-payload SSE replay events:
 * where tool-call arguments live in a COMPLETE (non-delta) body, so restore-into-tools withholding
 * covers non-streaming responses and provider replays, not just streamed deltas. An `unknown` wire
 * returns no regions — with no shape knowledge the blanket restore is kept (see threat-model.md).
 */
export function bufferedRestoreAdapterFor(wire: Wire): BufferedRestoreAdapter {
  switch (wire) {
    case "anthropic":
      return ANTHROPIC_BUFFERED_ADAPTER;
    case "openai-chat":
      return OPENAI_CHAT_BUFFERED_ADAPTER;
    case "openai-responses":
      return OPENAI_RESPONSES_BUFFERED_ADAPTER;
    default:
      return NOOP_BUFFERED_RESTORE_ADAPTER;
  }
}

const ANTHROPIC_BUFFERED_ADAPTER: BufferedRestoreAdapter = {
  // Non-stream /v1/messages: content[].type === "tool_use" → input (object; scanned via stringify,
  // never rewritten). SSE shapes covered for completeness: message_start nests content under
  // `message`, content_block_start carries a bare `content_block` (input is `{}` mid-stream).
  toolArgumentTexts(body) {
    if (!isRecord(body)) return [];
    const regions: string[] = [];
    collectAnthropicToolUse(body.content, regions);
    if (isRecord(body.message)) collectAnthropicToolUse(body.message.content, regions);
    collectAnthropicToolUseBlock(body.content_block, regions);
    return regions;
  },
};

const OPENAI_CHAT_BUFFERED_ADAPTER: BufferedRestoreAdapter = {
  // Non-stream chat completion: choices[].message.tool_calls[].function.arguments (a JSON string).
  toolArgumentTexts(body) {
    if (!isRecord(body) || !Array.isArray(body.choices)) return [];
    const regions: string[] = [];
    for (const choice of body.choices) {
      if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) continue;
      for (const toolCall of choice.message.tool_calls) {
        if (isRecord(toolCall) && isRecord(toolCall.function) && typeof toolCall.function.arguments === "string") {
          regions.push(toolCall.function.arguments);
        }
      }
    }
    return regions;
  },
};

const OPENAI_RESPONSES_BUFFERED_ADAPTER: BufferedRestoreAdapter = {
  // Non-stream response: output[].type === "function_call" → arguments (a JSON string). SSE replay
  // events re-send the same completed items nested under `response` (response.completed) or as a
  // bare `item` (response.output_item.added/done).
  toolArgumentTexts(body) {
    if (!isRecord(body)) return [];
    const regions: string[] = [];
    collectResponsesFunctionCalls(body.output, regions);
    if (isRecord(body.response)) collectResponsesFunctionCalls(body.response.output, regions);
    collectResponsesFunctionCall(body.item, regions);
    return regions;
  },
};

function collectAnthropicToolUse(content: unknown, regions: string[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) collectAnthropicToolUseBlock(block, regions);
}

function collectAnthropicToolUseBlock(block: unknown, regions: string[]): void {
  if (!isRecord(block) || block.type !== "tool_use" || block.input === undefined) return;
  const text = JSON.stringify(block.input);
  if (text) regions.push(text);
}

function collectResponsesFunctionCalls(output: unknown, regions: string[]): void {
  if (!Array.isArray(output)) return;
  for (const item of output) collectResponsesFunctionCall(item, regions);
}

function collectResponsesFunctionCall(item: unknown, regions: string[]): void {
  if (isRecord(item) && item.type === "function_call" && typeof item.arguments === "string") {
    regions.push(item.arguments);
  }
}

const ANTHROPIC_ADAPTER: SseRestoreAdapter = {
  fragments(data, eventName) {
    if (!isRecord(data)) return [];
    return anthropicStreamingTextFragments(data, eventName);
  },
  stopPrefixes(data) {
    if (!isRecord(data)) return [];
    if (data.type === "content_block_stop") return [`anthropic:${String(data.index)}:`];
    if (data.type === "message_stop") return ["anthropic:"];
    return [];
  },
};

const OPENAI_CHAT_ADAPTER: SseRestoreAdapter = {
  fragments(data, eventName) {
    if (!isRecord(data)) return [];
    return openAiChatStreamingTextFragments(data, eventName);
  },
  // Chat Completions has no per-block "done" event; pending tails flush on `[DONE]` (handled
  // generically by the vault) and on final stream flush.
  stopPrefixes: () => [],
};

const OPENAI_RESPONSES_ADAPTER: SseRestoreAdapter = {
  fragments(data, eventName) {
    if (!isRecord(data)) return [];
    return openAiResponsesStreamingTextFragments(data, eventName);
  },
  stopPrefixes(data) {
    if (!isRecord(data)) return [];
    if (data.type === "response.output_text.done") return [openAiResponseTextKey(data)];
    if (data.type === "response.function_call_arguments.done") return [openAiResponseArgumentsKey(data)];
    if (data.type === "response.completed") return ["openai-responses:"];
    return [];
  },
};

function anthropicStreamingTextFragments(data: Record<string, unknown>, eventName?: string): StreamingTextFragment[] {
  if (data.type !== "content_block_delta") return [];
  const delta = data.delta;
  if (!isRecord(delta)) return [];
  const index = data.index;

  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return [
      {
        kind: "tool",
        key: `anthropic:${String(index)}:partial_json`,
        value: delta.partial_json,
        eventName: eventName ?? "content_block_delta",
        setValue: (value) => {
          delta.partial_json = value;
        },
        flushData: (value) => anthropicDeltaData(index, "partial_json", value),
      },
    ];
  }

  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return [
      {
        kind: "text",
        key: `anthropic:${String(index)}:text`,
        value: delta.text,
        eventName: eventName ?? "content_block_delta",
        setValue: (value) => {
          delta.text = value;
        },
        flushData: (value) => anthropicDeltaData(index, "text", value),
      },
    ];
  }

  return [];
}

function openAiChatStreamingTextFragments(data: Record<string, unknown>, eventName?: string): StreamingTextFragment[] {
  if (!Array.isArray(data.choices)) return [];
  const fragments: StreamingTextFragment[] = [];
  for (const [choicePosition, choice] of data.choices.entries()) {
    if (!isRecord(choice)) continue;
    const delta = choice.delta;
    if (!isRecord(delta)) continue;
    const choiceIndex = choice.index ?? choicePosition;

    if (typeof delta.content === "string") {
      fragments.push({
        kind: "text",
        key: `openai-chat:${String(choiceIndex)}:content`,
        value: delta.content,
        eventName,
        setValue: (value) => {
          delta.content = value;
        },
        flushData: (value) => openAiChatDeltaData(data, choiceIndex, { content: value }),
      });
    }

    if (!Array.isArray(delta.tool_calls)) continue;
    for (const [toolPosition, toolCall] of delta.tool_calls.entries()) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      const toolIndex = toolCall.index ?? toolPosition;
      if (typeof toolCall.function.arguments !== "string") continue;
      fragments.push({
        kind: "tool",
        key: `openai-chat:${String(choiceIndex)}:tool:${String(toolIndex)}:arguments`,
        value: toolCall.function.arguments,
        eventName,
        setValue: (value) => {
          if (isRecord(toolCall.function)) toolCall.function.arguments = value;
        },
        flushData: (value) =>
          openAiChatDeltaData(data, choiceIndex, {
            tool_calls: [{ index: toolIndex, function: { arguments: value } }],
          }),
      });
    }
  }
  return fragments;
}

function openAiResponsesStreamingTextFragments(
  data: Record<string, unknown>,
  eventName?: string,
): StreamingTextFragment[] {
  if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
    return [
      {
        kind: "text",
        key: openAiResponseTextKey(data),
        value: data.delta,
        eventName,
        setValue: (value) => {
          data.delta = value;
        },
        flushData: (value) => ({ ...data, delta: value }),
      },
    ];
  }

  if (data.type === "response.function_call_arguments.delta" && typeof data.delta === "string") {
    return [
      {
        kind: "tool",
        key: openAiResponseArgumentsKey(data),
        value: data.delta,
        eventName,
        setValue: (value) => {
          data.delta = value;
        },
        flushData: (value) => ({ ...data, delta: value }),
      },
    ];
  }

  return [];
}

function anthropicDeltaData(index: unknown, field: "partial_json" | "text", value: string): Record<string, unknown> {
  const delta =
    field === "partial_json" ? { type: "input_json_delta", partial_json: value } : { type: "text_delta", text: value };
  const data: Record<string, unknown> = { type: "content_block_delta", delta };
  if (index !== undefined) data.index = index;
  return data;
}

function openAiChatDeltaData(
  source: Record<string, unknown>,
  choiceIndex: unknown,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const { choices: _choices, ...rest } = source;
  return { ...rest, choices: [{ index: choiceIndex, delta }] };
}

function openAiResponseTextKey(data: Record<string, unknown>): string {
  return `openai-responses:${String(data.item_id ?? data.output_index ?? "")}:${String(data.content_index ?? "")}:text`;
}

function openAiResponseArgumentsKey(data: Record<string, unknown>): string {
  return `openai-responses:${String(data.item_id ?? data.output_index ?? "")}:arguments`;
}
