import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { createFileRoute } from "@tanstack/react-router";
import { scopeFromAuth } from "../../lib/auth/guards.server";
import { getActiveProvider } from "../../lib/auth/provider.server";
import { isAdmin } from "../../lib/auth/types";
import { createModelAdapter } from "../../lib/model-adapter";
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  PROVIDERS,
  type Provider,
  type ReasoningEffort,
} from "../../lib/models";
import { recordProtectionStatsTrend } from "../../lib/protection-stats.server";
import { MissingKeyError, ProviderKeyDecryptionError, resolveProviderApiKey } from "../../lib/provider-keys.server";
import { stripRestoreHighlightMarkers } from "../../lib/restore-highlights";
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
        try {
          const body = await request.json();
          provider = body.forwardedProps?.provider ?? "openai";
          model = body.forwardedProps?.model ?? "gpt-5-mini";
          reasoningEffort = isReasoningEffort(body.forwardedProps?.reasoningEffort)
            ? body.forwardedProps.reasoningEffort
            : DEFAULT_REASONING_EFFORT;
          requestedTraceEnabled = body.forwardedProps?.traceEnabled === true;
          messages = stripRestoreHighlightMarkers(body.messages);
          threadId = typeof body.threadId === "string" ? body.threadId.slice(0, 128) : undefined;
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
        const [instance, storedThread] = await Promise.all([
          storage.getInstanceSettings(orgId),
          threadId ? storage.getThread(userId, orgId, threadId) : Promise.resolve(null),
        ]);
        if (!isModelAllowed(instance, `${provider}/${model}`)) {
          return errorResponse(403, "model not enabled on this instance");
        }

        let stream: ReturnType<typeof chat>;
        try {
          // The ficta scope key pins a persistent per-thread detected-PII vault in the proxy, so a
          // value detected on an earlier turn stays redacted when the restored transcript is resent.
          // The org id comes from server-side auth (never the client), so one org's threads can
          // never address another's vault; the client-chosen threadId only partitions within it.
          recordProtectionStatsTrend(orgId).catch((err: unknown) => {
            console.warn("Failed to ingest redaction proof trend.", err);
          });
          const fictaScope = threadId ? `${orgId}:${threadId}` : undefined;
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
              traceEnabled,
            }),
            messages,
            modelOptions: provider === "openai" ? { reasoning: { effort: reasoningEffort } } : undefined,
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
