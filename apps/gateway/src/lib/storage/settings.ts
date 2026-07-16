import { createServerFn } from "@tanstack/react-start";
import { optionalScope, requireAdminScope, requireUserId } from "@/lib/auth/guards.server";
import { isReasoningEffort, MODELS } from "@/lib/models";
import { isProtectionReviewMode } from "@/lib/protection-review-mode";
import { getStorage } from "./storage.server";
import { type InstanceSettings, modelKey, normalizeSuggestedPrompts, type UserSettings } from "./types";

/**
 * Server functions for reading/writing settings. They mirror `fetchAuthState`: the createServerFn boundary
 * keeps the DB driver server-only and picks up the CSRF middleware from start.ts. Every handler re-derives
 * identity via the guards — client input carries the settings patch, never a userId, and admin writes are
 * gated server-side regardless of what the UI showed. Validators are hand-rolled (no zod dep, matching the
 * codebase) and reject anything not backed by a real MODELS entry.
 */

const MODEL_KEYS = new Set(MODELS.map(modelKey));
const INSTANCE_NAME_MAX = 60;
export const RETENTION_DAYS_MAX = 36_500;

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) throw new Error("invalid settings payload");
  return input as Record<string, unknown>;
}

function validateUserPatch(input: unknown): Partial<UserSettings> {
  const i = asObject(input);
  const patch: Partial<UserSettings> = {};
  if ("defaultModel" in i) {
    const dm = i.defaultModel;
    if (typeof dm !== "object" || dm === null) throw new Error("invalid defaultModel");
    const { provider, model } = dm as Record<string, unknown>;
    if (typeof provider !== "string" || typeof model !== "string" || !MODEL_KEYS.has(`${provider}/${model}`)) {
      throw new Error("unknown model");
    }
    patch.defaultModel = { provider, model };
  }
  if ("defaultReasoningEffort" in i) {
    const effort = i.defaultReasoningEffort;
    if (!isReasoningEffort(effort)) throw new Error("invalid defaultReasoningEffort");
    patch.defaultReasoningEffort = effort;
  }
  return patch;
}

export function validateInstancePatch(input: unknown): Partial<InstanceSettings> {
  const i = asObject(input);
  const patch: Partial<InstanceSettings> = {};
  if ("instanceName" in i) {
    const name = i.instanceName;
    if (name !== undefined && typeof name !== "string") throw new Error("invalid instanceName");
    const trimmed = typeof name === "string" ? name.trim().slice(0, INSTANCE_NAME_MAX) : "";
    patch.instanceName = trimmed || undefined;
  }
  if ("allowedModels" in i) {
    const list = i.allowedModels;
    if (!Array.isArray(list)) throw new Error("invalid allowedModels");
    // Keep only keys backed by a real model. An empty result means "all allowed" (see isModelAllowed),
    // so an admin unchecking everything can never brick chat.
    patch.allowedModels = list.filter((k): k is string => typeof k === "string" && MODEL_KEYS.has(k));
  }
  if ("suggestedPrompts" in i) {
    patch.suggestedPrompts = normalizeSuggestedPrompts(i.suggestedPrompts);
  }
  if ("protectionReviewMinimum" in i) {
    if (!isProtectionReviewMode(i.protectionReviewMinimum)) throw new Error("invalid protectionReviewMinimum");
    patch.protectionReviewMinimum = i.protectionReviewMinimum;
  }
  if ("deletedThreadRecoveryDays" in i) {
    patch.deletedThreadRecoveryDays = retentionDays(i.deletedThreadRecoveryDays, "deletedThreadRecoveryDays");
  }
  if ("recordsAuditRetentionDays" in i) {
    patch.recordsAuditRetentionDays = retentionDays(i.recordsAuditRetentionDays, "recordsAuditRetentionDays");
  }
  return patch;
}

function retentionDays(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > RETENTION_DAYS_MAX) {
    throw new Error(`${field} must be a whole number from 1 to ${RETENTION_DAYS_MAX}`);
  }
  return value as number;
}

export const fetchUserSettings = createServerFn({ method: "GET" }).handler(async (): Promise<UserSettings> => {
  const userId = await requireUserId();
  return (await getStorage()).getUserSettings(userId);
});

export const updateUserSettings = createServerFn({ method: "POST" })
  .validator(validateUserPatch)
  .handler(async ({ data }): Promise<UserSettings> => {
    const userId = await requireUserId();
    return (await getStorage()).patchUserSettings(userId, data);
  });

/**
 * Public read: the root loader and ModelPicker need the active workspace's config regardless of who's signed
 * in. Scope is resolved leniently — a signed-out request under a real provider (before the root gate
 * redirects) gets empty defaults rather than a 500.
 */
export const fetchInstanceSettings = createServerFn({ method: "GET" }).handler(async (): Promise<InstanceSettings> => {
  const scope = await optionalScope();
  if (!scope) return {};
  return (await getStorage()).getInstanceSettings(scope.orgId);
});

export const updateInstanceSettings = createServerFn({ method: "POST" })
  .validator(validateInstancePatch)
  .handler(async ({ data }): Promise<InstanceSettings> => {
    const { userId, orgId } = await requireAdminScope();
    const current = await (await getStorage()).getInstanceSettings(orgId);
    const nextRecovery =
      "deletedThreadRecoveryDays" in data ? data.deletedThreadRecoveryDays : current.deletedThreadRecoveryDays;
    const nextAudit =
      "recordsAuditRetentionDays" in data ? data.recordsAuditRetentionDays : current.recordsAuditRetentionDays;
    if (nextRecovery !== undefined && nextAudit === undefined) {
      throw new Error("Records audit retention is required when deleted-chat recovery is enabled.");
    }
    if (nextRecovery !== undefined && nextAudit !== undefined && nextAudit < nextRecovery) {
      throw new Error("Audit evidence must be retained at least as long as deleted chats.");
    }
    return (await getStorage()).patchInstanceSettings(orgId, data, userId);
  });
