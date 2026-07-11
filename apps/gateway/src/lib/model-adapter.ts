import {
  FICTA_EGRESS_EVENT_HEADER,
  FICTA_PROTECTION_TICKET_HEADER,
  FICTA_RESTORE_HIGHLIGHT_HEADER,
  FICTA_SCOPE_HEADER,
  FICTA_TRACE_CAPTURE_HEADER,
} from "@serovaai/ficta-protocol";
import { anthropicText } from "@tanstack/ai-anthropic";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import type { Provider } from "@/lib/models";

export interface ModelChoice {
  provider: Provider;
  model: string;
  apiKey: string;
  /**
   * ficta scope key for this conversation (server-derived `org:thread`). Sent as the internal
   * `x-ficta-scope` header so the proxy pins a persistent per-thread detected-PII vault: a value
   * detected on turn 1 stays redacted on every later turn even if detection misses it there. The
   * proxy strips the header before forwarding upstream. Omit for one-off requests.
   */
  fictaScope?: string;
  /** Server-derived per-thread trace/audit capture decision. Never sourced from browser forwarded props. */
  traceEnabled?: boolean;
  /** Opaque capability returned by the proxy's loopback-only pre-send protection preview. */
  protectionTicket?: string;
  /** Gateway-generated correlation id for the values-free per-request egress proof. */
  egressEventId?: string;
}

/**
 * The provider seam. `FICTA_PROXY_URL` points each adapter's `baseURL` at the ficta redaction proxy,
 * so PII / secrets are tokenized before the vendor and restored on the way back. The firm's real API
 * keys stay server-side (never sent to the browser). Swap provider / model wiring here — nowhere else.
 */
const FICTA_PROXY_URL = process.env.FICTA_PROXY_URL ?? "http://127.0.0.1:8787";

export function createModelAdapter({
  provider,
  model,
  apiKey,
  fictaScope,
  traceEnabled = false,
  protectionTicket,
  egressEventId,
}: ModelChoice) {
  const defaultHeaders = {
    // Advertises that this client can render restore-highlight markers — a static capability (the UI
    // always knows how). It's an internal handshake header (the proxy strips it before upstream), so
    // it's sent unconditionally; the proxy only emits markers when global trace audit and this thread's
    // trace capture are both enabled.
    [FICTA_RESTORE_HIGHLIGHT_HEADER]: "1",
    [FICTA_TRACE_CAPTURE_HEADER]: traceEnabled ? "1" : "0",
    ...(protectionTicket ? { [FICTA_PROTECTION_TICKET_HEADER]: protectionTicket } : {}),
    ...(fictaScope ? { [FICTA_SCOPE_HEADER]: fictaScope } : {}),
    ...(egressEventId ? { [FICTA_EGRESS_EVENT_HEADER]: egressEventId } : {}),
  };
  if (provider === "anthropic") {
    // ficta routes `/v1/messages` → the Anthropic upstream; the Anthropic adapter emits that wire.
    // The adapter's model param is a known-Claude-id union; the UI supplies a validated id, so cast.
    return anthropicText(model as Parameters<typeof anthropicText>[0], {
      baseURL: FICTA_PROXY_URL,
      apiKey,
      defaultHeaders,
    });
  }
  // Gateway uses OpenAI's Responses API so reasoning controls map to the correct wire shape.
  // ficta routes `/v1/responses` → the OpenAI upstream.
  return openaiCompatibleText(model, {
    api: "responses",
    baseURL: `${FICTA_PROXY_URL}/v1`,
    apiKey,
    defaultHeaders,
  });
}
