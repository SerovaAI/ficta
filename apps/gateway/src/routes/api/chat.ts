import { randomUUID } from "node:crypto";
import { FICTA_PROTECTION_PREVIEW_PATH, FICTA_SCOPE_HEADER, isProtectionPreviewOk } from "@serovaai/ficta-protocol";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { createFileRoute } from "@tanstack/react-router";
import { scopeFromAuth } from "../../lib/auth/guards.server";
import { getActiveProvider } from "../../lib/auth/provider.server";
import { isAdmin } from "../../lib/auth/types";
import { persistThreadEgressEvidence } from "../../lib/egress-evidence.server";
import { fictaScopeFor } from "../../lib/ficta-scope.server";
import { createModelAdapter } from "../../lib/model-adapter";
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  normalizeReasoningEffort,
  PROVIDERS,
  type Provider,
  type ReasoningEffort,
} from "../../lib/models";
import { type ProtectionReviewMode, protectionReviewRequiresPreview } from "../../lib/protection-review-mode";
import { recordProtectionStatsTrend } from "../../lib/protection-stats.server";
import { MissingKeyError, ProviderKeyDecryptionError, resolveProviderApiKey } from "../../lib/provider-keys.server";
import { proxyBaseUrl } from "../../lib/proxy-base.server";
import { stripProtectionDisplayMetadata } from "../../lib/restore-highlights";
import { getStorage } from "../../lib/storage/storage.server";
import { isModelAllowed } from "../../lib/storage/types";

/**
 * Server route the browser's useChat() talks to. It builds the TanStack AI adapter for the requested
 * provider/model — whose baseURL points at the ficta proxy — and streams the SSE response back. The
 * lawyer's document flows browser → here → ficta (redact) → vendor → ficta (restore) → here → browser.
 *
 * The SSE client (`fetchServerSentEvents`) throws on any non-2xx response, surfacing
 * `HTTP error! status: <code> <statusText>` as the `error` useChat() renders in the ErrorBanner — it
 * never reads the body. So the graceful path here is a non-2xx Response carrying a concise, non-secret
 * reason in `statusText`. Synchronous setup failures (bad JSON, unknown provider, missing server-side
 * key) are the day-one cases and are caught below; without this they'd throw uncaught → an opaque 500.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Defense in depth: even though the UI is gated, verify the session here — this is the route
        // that spends API keys. In `none` mode requiresAuth is false, so this is a no-op.
        const auth = await (await getActiveProvider()).getAuthState();
        const scope = scopeFromAuth(auth);
        if (auth.requiresAuth && !scope) return errorResponse(401, "sign in to chat");

        let provider: Provider;
        let model: string;
        let reasoningEffort: ReasoningEffort;
        let messages: Parameters<typeof chat>[0]["messages"];
        let threadId: string | undefined;
        let requestedTraceEnabled = false;
        let protectionTicket: string | undefined;
        try {
          const body = await request.json();
          provider = body.forwardedProps?.provider ?? "openai";
          model = body.forwardedProps?.model ?? "gpt-5-mini";
          reasoningEffort = resolveRequestedReasoningEffort(provider, model, body.forwardedProps?.reasoningEffort);
          requestedTraceEnabled = body.forwardedProps?.traceEnabled === true;
          protectionTicket = cleanProtectionTicket(body.forwardedProps?.protectionTicket);
          messages = messagesForModel(body.messages);
          threadId = typeof body.threadId === "string" ? body.threadId.trim().slice(0, 128) || undefined : undefined;
          if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
          if (!model) throw new Error("no model selected");
        } catch (err) {
          return errorResponse(400, reason(err, "malformed chat request"));
        }

        // Enforce the instance allow-list server-side — the picker filters for UX, but this is the gate
        // that actually spends keys, so a forged request for a disabled model is rejected here.
        const storage = await getStorage();
        const userId = scope?.userId ?? "local";
        const orgId = scope?.orgId ?? "local";
        const [instance, storedThread, threadOwner] = await Promise.all([
          storage.getInstanceSettings(orgId),
          threadId ? storage.getThread(userId, orgId, threadId) : Promise.resolve(null),
          threadId ? storage.getThreadOwner(threadId) : Promise.resolve(null),
        ]);
        if (threadOwner && (threadOwner.userId !== userId || threadOwner.orgId !== orgId || threadOwner.deleted)) {
          return errorResponse(404, "chat not found");
        }
        if (!isModelAllowed(instance, `${provider}/${model}`)) {
          return errorResponse(403, "model not enabled on this instance");
        }
        if (requiresProtectionReviewTicket(instance, protectionTicket)) {
          return errorResponse(428, "protection review is required before sending");
        }
        if (protectionTicket && !threadId) return errorResponse(400, "a chat id is required for protection review");

        let stream: ReturnType<typeof chat>;
        try {
          // The ficta scope key pins a persistent per-thread detected-PII vault in the proxy, so a
          // value detected on an earlier turn stays redacted when the restored transcript is resent.
          // The org id comes from server-side auth (never the client), so one org's threads can
          // never address another's vault; the client-chosen threadId only partitions within it.
          recordProtectionStatsTrend(orgId).catch((err: unknown) => {
            console.warn("Failed to ingest redaction proof trend.", err);
          });
          const fictaScope = threadId ? fictaScopeFor(orgId, userId, threadId) : undefined;
          const egressEventId = threadId && fictaScope ? randomUUID() : undefined;
          if (!protectionTicket && threadId && fictaScope) {
            const protectedValues = await storage.listThreadProtectedValues(userId, orgId, threadId);
            if (protectedValues.length > 0) {
              const currentUserText = latestUserText(messages);
              if (!currentUserText) throw new Error("the current user message could not be prepared for protection");
              protectionTicket = await prepareStoredThreadProtection(fictaScope, currentUserText, protectedValues);
            }
          }
          const apiKey = await resolveProviderApiKey(orgId, provider);
          const traceEnabled = resolveChatTraceEnabled({
            storedTraceEnabled: storedThread?.thread.traceEnabled,
            requestedTraceEnabled,
            admin: isAdmin(auth),
          });
          stream = chat({
            adapter: createModelAdapter({
              provider,
              model,
              apiKey,
              fictaScope,
              egressEventId,
              traceEnabled,
              protectionTicket,
            }),
            messages,
            modelOptions: modelOptionsForProvider(provider, reasoningEffort),
            middleware:
              threadId && fictaScope && egressEventId
                ? [
                    {
                      name: "persist-egress-evidence",
                      onFinish: () =>
                        persistThreadEgressEvidence({ userId, orgId, threadId, fictaScope, eventId: egressEventId }),
                      onAbort: () =>
                        persistThreadEgressEvidence({ userId, orgId, threadId, fictaScope, eventId: egressEventId }),
                      onError: () =>
                        persistThreadEgressEvidence({ userId, orgId, threadId, fictaScope, eventId: egressEventId }),
                    },
                  ]
                : undefined,
          });
        } catch (err) {
          if (err instanceof MissingKeyError || err instanceof ProviderKeyDecryptionError) {
            return errorResponse(503, err.message);
          }
          return errorResponse(502, reason(err, "could not reach the model via ficta"));
        }

        return toServerSentEventsResponse(stream);
      },
    },
  },
});

/**
 * A non-2xx Response whose reason phrase the SSE client turns into `error.message`. Keep it a single
 * clean ASCII line — HTTP reason phrases forbid CR/LF and can be dropped or mangled under HTTP/2.
 */
function errorResponse(status: number, message: string): Response {
  const statusText = message.replace(/[\r\n]+/g, " ").slice(0, 120);
  return new Response(statusText, { status, statusText });
}

function reason(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}

/** Normalize untrusted/stale client effort values before building the upstream OpenAI request. */
export function resolveRequestedReasoningEffort(provider: string, model: string, value: unknown): ReasoningEffort {
  const effort = isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT;
  return normalizeReasoningEffort({ provider, model }, effort);
}

/** Minimize OpenAI response application-state storage; this does not assert organization-level ZDR. */
export function modelOptionsForProvider(provider: Provider, reasoningEffort: ReasoningEffort) {
  return provider === "openai" ? { reasoning: { effort: reasoningEffort }, store: false as const } : undefined;
}

function cleanProtectionTicket(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ticket = value.trim();
  return /^[0-9a-f-]{20,80}$/i.test(ticket) ? ticket : undefined;
}

async function prepareStoredThreadProtection(
  fictaScope: string,
  currentUserText: string,
  protectedValues: string[],
): Promise<string> {
  const response = await fetch(`${proxyBaseUrl()}${FICTA_PROTECTION_PREVIEW_PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [FICTA_SCOPE_HEADER]: fictaScope,
    },
    body: JSON.stringify({ text: currentUserText, protectedValues }),
  });
  const json = (await response.json()) as unknown;
  if (!response.ok || !isProtectionPreviewOk(json)) {
    throw new Error("stored chat protections could not be prepared; review protection and try again");
  }
  return json.ticket;
}

export function latestUserText(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as unknown;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;
    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.parts)) return undefined;
    const text = record.parts
      .flatMap((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const partRecord = part as Record<string, unknown>;
        return partRecord.type === "text" && typeof partRecord.content === "string" ? [partRecord.content] : [];
      })
      .join("");
    return text || undefined;
  }
  return undefined;
}

/** Remove Ficta's browser-only evidence before TanStack converts UI parts into provider messages. */
export function messagesForModel<T>(messages: T): T {
  return stripProtectionDisplayMetadata(messages);
}

export function resolveChatTraceEnabled({
  storedTraceEnabled,
  requestedTraceEnabled,
  admin,
}: {
  storedTraceEnabled: boolean | undefined;
  requestedTraceEnabled: boolean;
  admin: boolean;
}): boolean {
  return storedTraceEnabled ?? (requestedTraceEnabled && admin);
}

export function requiresProtectionReviewTicket(
  instance: { protectionReviewMinimum?: ProtectionReviewMode },
  protectionTicket: string | undefined,
): boolean {
  return protectionReviewRequiresPreview(instance.protectionReviewMinimum ?? "off") && !protectionTicket;
}
