/**
 * Surrogate literal-preservation instruction.
 *
 * Restore only works when the model reproduces a surrogate token exactly; models often truncate long
 * opaque tokens (`FICTA_62a02923…`), editorialise them ("this is a placeholder"), or drop them. This
 * module builds a system/developer instruction — carrying the exact allow-list of surrogates present in
 * the outbound request — and injects it into the request body per provider wire, so the model is told to
 * preserve those literals verbatim. It is a mitigation, not a guarantee (pair it with response
 * validation); it only ever adds surrogate tokens the proxy itself minted, never raw protected values.
 */

import type { Wire } from "./wire.js";

// Cap the explicit allow-list so a pathological request can't bloat the prompt. Beyond this the policy
// still applies (the model is told there are more of the same form); the listed ones are the strong hint.
const MAX_LISTED_SURROGATES = 500;

/** The system-prompt text: the preservation policy plus the exact allow-list of surrogates to preserve. */
export function buildPreservationInstruction(surrogates: readonly string[]): string {
  const listed = surrogates.slice(0, MAX_LISTED_SURROGATES);
  const lines = [
    "The messages below contain protected literal identifiers — real tokens in the source text, not " +
      "placeholders, redaction markers, or comments. For every protected identifier you must:",
    "- reproduce it exactly, character-for-character, wherever it appears in your response;",
    '- never shorten or truncate it, and never replace any part of it with an ellipsis ("...");',
    "- never describe it as a placeholder, redacted, or a token, and never omit it as “redacted”;",
    "- never invent new identifiers of this form.",
    "When you quote, summarise, tabulate, translate, or rewrite any passage containing one, the " +
      "identifier must appear verbatim in your output.",
    `Protected identifiers in this input: ${listed.join(", ")}`,
  ];
  if (surrogates.length > listed.length) {
    lines.push(`(and ${surrogates.length - listed.length} more of the same form; the same rules apply to all.)`);
  }
  return lines.join("\n");
}

/**
 * Inject the preservation instruction into a redacted request body at the wire's system/developer slot.
 * Returns the body unchanged when there is nothing to do (no surrogates, unknown wire, non-JSON body, or
 * an unrecognised shape) so it can never corrupt a request it does not understand.
 */
export function withPreservationInstruction(body: string, wire: Wire, surrogates: readonly string[]): string {
  if (wire === "unknown" || surrogates.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // non-JSON body: nothing safe to modify
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;

  const obj = parsed as Record<string, unknown>;
  const instruction = buildPreservationInstruction(surrogates);

  switch (wire) {
    case "openai-responses": {
      // Responses API carries the system prompt in `instructions`; prepend so ours leads.
      const existing = typeof obj.instructions === "string" ? obj.instructions : "";
      obj.instructions = existing ? `${instruction}\n\n${existing}` : instruction;
      break;
    }
    case "openai-chat": {
      // Chat Completions: a leading system message. Only touch a well-formed messages array.
      if (!Array.isArray(obj.messages)) return body;
      obj.messages = [{ role: "system", content: instruction }, ...obj.messages];
      break;
    }
    case "anthropic": {
      // Anthropic `system` is a string or an array of content blocks; prepend in whichever shape is present.
      const existing = obj.system;
      if (typeof existing === "string") {
        obj.system = existing ? `${instruction}\n\n${existing}` : instruction;
      } else if (Array.isArray(existing)) {
        obj.system = [{ type: "text", text: instruction }, ...existing];
      } else {
        obj.system = instruction;
      }
      break;
    }
  }

  return JSON.stringify(obj);
}
