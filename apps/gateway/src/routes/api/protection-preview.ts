import {
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_SCOPE_HEADER,
  isProtectionPreviewOk,
  type ProtectionPreviewOk,
} from "@serovaai/ficta-protocol";
import { createFileRoute } from "@tanstack/react-router";
import { scopeFromAuth } from "../../lib/auth/guards.server";
import { getActiveProvider } from "../../lib/auth/provider.server";
import { fictaScopeFor } from "../../lib/ficta-scope.server";
import { proxyBaseUrl } from "../../lib/proxy-base.server";
import { getStorage, type Storage, ThreadProtectionLimitError } from "../../lib/storage/storage.server";

const TEXT_MAX = 2 * 1024 * 1024;
const VALUE_MAX = 2_000;
const VALUES_PER_REQUEST_MAX = 20;
const ABANDONED_CLEANUP_INTERVAL_MS = 60 * 60_000;
const abandonedCleanupAfter = new Map<string, number>();

export const Route = createFileRoute("/api/protection-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await (await getActiveProvider()).getAuthState();
        const scope = scopeFromAuth(auth);
        if (auth.requiresAuth && !scope) return errorResponse(401, "Sign in to review protection.");

        let input: PreviewInput;
        try {
          input = validateInput(await request.json());
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : "Invalid protection preview.");
        }

        const userId = scope?.userId ?? "local";
        const orgId = scope?.orgId ?? "local";
        const storage = await getStorage();
        let protectedValues: string[];
        try {
          const owner = await storage.getThreadOwner(input.threadId);
          if (owner && (owner.userId !== userId || owner.orgId !== orgId || owner.deleted)) {
            return errorResponse(404, "Chat not found.");
          }
          protectedValues =
            input.addValues.length > 0 || input.removeValues.length > 0
              ? await storage.updateThreadProtectedValues(userId, orgId, input.threadId, {
                  add: input.addValues,
                  remove: input.removeValues,
                })
              : await storage.listThreadProtectedValues(userId, orgId, input.threadId);
          scheduleAbandonedCleanup(storage, userId, orgId);
        } catch (err) {
          if (err instanceof ThreadProtectionLimitError) return errorResponse(422, err.message);
          console.warn("Failed to update chat protection values.", err);
          return errorResponse(500, "Chat protection values could not be updated. Try again.");
        }

        try {
          const response = await fetch(`${proxyBaseUrl()}${FICTA_PROTECTION_PREVIEW_PATH}`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              [FICTA_SCOPE_HEADER]: fictaScopeFor(orgId, userId, input.threadId),
            },
            body: JSON.stringify({ text: input.text, protectedValues }),
          });
          const json = (await response.json()) as unknown;
          if (!response.ok || !isProtectionPreviewOk(json)) {
            const message = previewErrorMessage(json) ?? `Protection preview failed (HTTP ${response.status}).`;
            return errorResponse(response.status >= 400 ? response.status : 502, message);
          }
          return Response.json({ ...json, protectedValues } satisfies GatewayProtectionPreview);
        } catch {
          return errorResponse(502, "Could not reach the ficta proxy. Check that it is running, then try again.");
        }
      },
    },
  },
});

interface PreviewInput {
  threadId: string;
  text: string;
  addValues: string[];
  removeValues: string[];
}

export interface GatewayProtectionPreview extends ProtectionPreviewOk {
  /** Chat-scoped selections already remembered by Gateway. */
  protectedValues: string[];
}

function validateInput(value: unknown): PreviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preview body must be an object.");
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== "string" || !record.threadId.trim()) throw new Error("Chat id is required.");
  if (typeof record.text !== "string" || !record.text.trim()) throw new Error("Write a message before reviewing it.");
  if (new TextEncoder().encode(record.text).byteLength > TEXT_MAX)
    throw new Error("This message is too large to preview.");
  const addValues = validateValues(record.addValues, "added");
  const removeValues = validateValues(record.removeValues, "removed");
  return {
    threadId: record.threadId.trim().slice(0, 128),
    text: record.text,
    addValues,
    removeValues,
  };
}

function validateValues(value: unknown, action: "added" | "removed"): string[] {
  const rawValues = value === undefined ? [] : value;
  if (!Array.isArray(rawValues) || rawValues.length > VALUES_PER_REQUEST_MAX) {
    throw new Error(`Too many selections were ${action} at once.`);
  }
  const values = rawValues.map((entry) => {
    if (typeof entry !== "string") throw new Error("A protected selection must be text.");
    const normalized = entry.trim();
    if (!normalized || normalized.length > VALUE_MAX) throw new Error("A protected selection is empty or too long.");
    return normalized;
  });
  return [...new Set(values)];
}

function previewErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ ok: false, message }, { status });
}

function scheduleAbandonedCleanup(storage: Storage, userId: string, orgId: string): void {
  const key = JSON.stringify([userId, orgId]);
  const now = Date.now();
  if ((abandonedCleanupAfter.get(key) ?? 0) > now) return;
  abandonedCleanupAfter.set(key, now + ABANDONED_CLEANUP_INTERVAL_MS);
  setTimeout(() => {
    void storage.pruneAbandonedThreadProtectedValues(userId, orgId).catch((err: unknown) => {
      abandonedCleanupAfter.delete(key);
      console.warn("Failed to prune abandoned chat protections.", err);
    });
  }, 0);
}
