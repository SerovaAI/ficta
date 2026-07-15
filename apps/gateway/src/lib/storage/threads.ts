import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope, requireAuthState, requireScope, scopeFromAuth } from "@/lib/auth/guards.server";
import { isAdmin } from "@/lib/auth/types";
import { isReasoningEffort, MODELS, normalizeReasoningEffort } from "@/lib/models";
import { getStorage } from "./storage.server";
import type { StoredMessage, ThreadEgressReceipt, ThreadModelSettings, ThreadSummary } from "./types";

/**
 * Server functions for chat history. Like settings.ts, each re-derives the caller's scope (userId + the
 * active workspace orgId) via the guard, so a client can only read/write its own threads within its current
 * workspace (the store also enforces ownership). Messages are stored opaque — `parts` is validated to be an
 * array but not interpreted. Titles are derived in the store from the first user message.
 */

const ROLES = new Set(["system", "user", "assistant"]);

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) throw new Error("invalid payload");
  return input as Record<string, unknown>;
}

function requireThreadId(input: unknown): { threadId: string } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  return { threadId: i.threadId };
}

function toStoredMessage(input: unknown): StoredMessage {
  const o = asObject(input);
  if (typeof o.id !== "string" || typeof o.role !== "string" || !ROLES.has(o.role) || !Array.isArray(o.parts)) {
    throw new Error("invalid message");
  }
  return {
    id: o.id,
    role: o.role as StoredMessage["role"],
    parts: o.parts,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : undefined,
  };
}

function toThreadModelSettings(input: unknown): ThreadModelSettings {
  const i = asObject(input);
  if (typeof i.provider !== "string" || typeof i.model !== "string" || !isReasoningEffort(i.reasoningEffort)) {
    throw new Error("invalid model settings");
  }
  const choice = MODELS.find((candidate) => candidate.provider === i.provider && candidate.model === i.model);
  if (!choice) throw new Error("unknown model");
  return {
    provider: choice.provider,
    model: choice.model,
    reasoningEffort: normalizeReasoningEffort(choice, i.reasoningEffort),
  };
}

function optionalThreadModelSettings(input: Record<string, unknown>): ThreadModelSettings | undefined {
  return input.modelSettings === undefined ? undefined : toThreadModelSettings(input.modelSettings);
}

function validateStart(input: unknown): {
  threadId: string;
  message: StoredMessage;
  traceEnabled: boolean;
  modelSettings?: ThreadModelSettings;
} {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  if (i.traceEnabled !== undefined && typeof i.traceEnabled !== "boolean") throw new Error("invalid traceEnabled");
  return {
    threadId: i.threadId,
    message: toStoredMessage(i.message),
    traceEnabled: i.traceEnabled === true,
    modelSettings: optionalThreadModelSettings(i),
  };
}

function validateSnapshot(input: unknown): {
  threadId: string;
  messages: StoredMessage[];
  modelSettings?: ThreadModelSettings;
} {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  if (!Array.isArray(i.messages)) throw new Error("invalid messages");
  return {
    threadId: i.threadId,
    messages: i.messages.map(toStoredMessage),
    modelSettings: optionalThreadModelSettings(i),
  };
}

function validateTraceToggle(input: unknown): { threadId: string; traceEnabled: boolean } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  if (typeof i.traceEnabled !== "boolean") throw new Error("invalid traceEnabled");
  return { threadId: i.threadId, traceEnabled: i.traceEnabled };
}

function validateModelSettings(input: unknown): { threadId: string; modelSettings: ThreadModelSettings } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  return { threadId: i.threadId, modelSettings: toThreadModelSettings(i.modelSettings) };
}

export const fetchThreads = createServerFn({ method: "GET" }).handler(async (): Promise<ThreadSummary[]> => {
  const { userId, orgId } = await requireScope();
  return (await getStorage()).listThreads(userId, orgId);
});

export const fetchThread = createServerFn({ method: "GET" })
  .validator(requireThreadId)
  .handler(async ({ data }): Promise<{ thread: ThreadSummary; messages: StoredMessage[] } | null> => {
    const { userId, orgId } = await requireScope();
    return (await getStorage()).getThread(userId, orgId, data.threadId);
  });

/** Values-free, per-thread provider-egress evidence. The transcript itself is never returned here. */
export const fetchThreadEgressReceipt = createServerFn({ method: "GET" })
  .validator(requireThreadId)
  .handler(async ({ data }): Promise<ThreadEgressReceipt> => {
    const { userId, orgId } = await requireScope();
    return (await getStorage()).getThreadEgressReceipt(userId, orgId, data.threadId);
  });

export const startThread = createServerFn({ method: "POST" })
  .validator(validateStart)
  .handler(async ({ data }): Promise<void> => {
    const auth = await requireAuthState();
    const scope = scopeFromAuth(auth);
    if (!scope) throw new Error("unauthorized");
    await (await getStorage()).startThread(
      scope.userId,
      scope.orgId,
      data.threadId,
      data.message,
      data.traceEnabled && isAdmin(auth),
      data.modelSettings,
    );
  });

export const saveThread = createServerFn({ method: "POST" })
  .validator(validateSnapshot)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).saveThreadSnapshot(userId, orgId, data.threadId, data.messages, data.modelSettings);
  });

export const setThreadModelSettings = createServerFn({ method: "POST" })
  .validator(validateModelSettings)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).setThreadModelSettings(userId, orgId, data.threadId, data.modelSettings);
  });

export const setThreadTraceEnabled = createServerFn({ method: "POST" })
  .validator(validateTraceToggle)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireAdminScope();
    await (await getStorage()).setThreadTraceEnabled(userId, orgId, data.threadId, data.traceEnabled);
  });

export const deleteThread = createServerFn({ method: "POST" })
  .validator(requireThreadId)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).deleteThread(userId, orgId, data.threadId);
  });
