/**
 * Client-safe storage types. Imported by React components, route loaders, and the server store alike —
 * so it must pull in NO server code (no drizzle, no pg, no pglite). The shapes here are the contract of
 * the `Storage` seam (storage.server.ts); everything crossing the server-function boundary is one of
 * these plain, JSON-serializable objects, which is also what keeps a future Convex backend a drop-in.
 */

import type { EgressProof, ProtectionStatsSnapshot, ProtectionStatsTotals } from "@serovaai/ficta-protocol";
import type { Provider, ReasoningEffort } from "@/lib/models";
import type { ProtectionReviewMode } from "@/lib/protection-review-mode";

/** Per-user preferences. All fields optional; reads merge over code defaults so a fresh user is valid. */
export interface UserSettings {
  /** The model pre-selected in a new chat. Validated against MODELS on write; ignored on read if stale. */
  defaultModel?: { provider: string; model: string };
  /** The reasoning level pre-selected for OpenAI models in the composer. */
  defaultReasoningEffort?: ReasoningEffort;
}

/** The model controls last selected for one saved chat. */
export interface ThreadModelSettings {
  provider: Provider;
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** Instance-wide (admin-owned) settings. One row, shared by everyone on this deployment. */
export interface InstanceSettings {
  /** Shown in the header in place of "ficta". */
  instanceName?: string;
  /** Allow-list of `"provider/model"` keys. Undefined or empty = every model in MODELS is allowed. */
  allowedModels?: string[];
  /** Empty-chat suggestion prompts. Undefined = defaults; empty array = hide prompt buttons. */
  suggestedPrompts?: string[];
  /** Lowest protection-review mode a chat may use. Undefined means no administrator-enforced minimum. */
  protectionReviewMinimum?: ProtectionReviewMode;
}

/** Client-visible metadata for a workspace provider key. Never includes plaintext or ciphertext. */
export interface ProviderKeySummary {
  provider: Provider;
  configured: boolean;
  keyHint: string;
  updatedAt: string;
}

export type { ProtectionStatsSnapshot, ProtectionStatsTotals };

export interface ProtectionStatsDailySummary extends ProtectionStatsTotals {
  day: string;
  updatedAt: string;
}

/** Values-free, append-only evidence for one provider-bound request in a chat thread. */
export interface ThreadEgressEvent extends EgressProof {
  threadId: string;
  previousHash?: string;
  eventHash: string;
}

/** A thread-level receipt is derived from its individual immutable egress events. */
export interface ThreadEgressReceipt {
  threadId: string;
  events: ThreadEgressEvent[];
  chainRoot?: string;
  forwardedRequests: number;
  blockedRequests: number;
  tokenizedValues: number;
  survivingValues: number;
  ambiguousEntityLinks: number;
}

/** Server-only encrypted provider key payload persisted by the storage backend. */
export interface EncryptedProviderKey {
  provider: Provider;
  ciphertext: string;
  iv: string;
  tag: string;
  keyHint: string;
}

export const PROTECTED_REGISTRY_ENTRY_TYPES = [
  "client",
  "counterparty",
  "person",
  "matter",
  "case",
  "contract",
  "account",
  "project",
  "vendor",
  "custodian",
  "other",
] as const;

export type ProtectedRegistryEntryType = (typeof PROTECTED_REGISTRY_ENTRY_TYPES)[number];

export const PROTECTED_REGISTRY_ENTRY_STATUSES = ["approved", "suggested", "ignored"] as const;

export type ProtectedRegistryEntryStatus = (typeof PROTECTED_REGISTRY_ENTRY_STATUSES)[number];

export const PROTECTED_REGISTRY_ENTRY_SOURCES = ["manual", "csv", "suggested"] as const;

export type ProtectedRegistryEntrySource = (typeof PROTECTED_REGISTRY_ENTRY_SOURCES)[number];

export const PROTECTED_REGISTRY_PROTECTION_KINDS = ["literal", "entity"] as const;
export type ProtectedRegistryProtectionKind = (typeof PROTECTED_REGISTRY_PROTECTION_KINDS)[number];

export const PROTECTED_REGISTRY_ENTITY_TYPES = ["organization", "person"] as const;
export type ProtectedRegistryEntityType = (typeof PROTECTED_REGISTRY_ENTITY_TYPES)[number];

export const PROTECTED_REGISTRY_FORM_KINDS = ["legal_name", "full_name", "short_name", "alias"] as const;
export type ProtectedRegistryFormKind = (typeof PROTECTED_REGISTRY_FORM_KINDS)[number];

export const PROTECTED_REGISTRY_FORM_BOUNDARIES = ["substring", "token"] as const;
export type ProtectedRegistryFormBoundary = (typeof PROTECTED_REGISTRY_FORM_BOUNDARIES)[number];
export const PROTECTED_REGISTRY_FORMS_MAX = 20;

export function normalizeProtectedRegistryValue(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export interface ProtectedRegistryEntryForm {
  value: string;
  kind: ProtectedRegistryFormKind;
  boundary: ProtectedRegistryFormBoundary;
}

interface ProtectedRegistryEntryFields {
  id: string;
  matterId: string;
  type: ProtectedRegistryEntryType;
  value: string;
  forms: ProtectedRegistryEntryForm[];
  source: ProtectedRegistryEntrySource;
  status: ProtectedRegistryEntryStatus;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProtectedRegistryEntry = ProtectedRegistryEntryFields &
  (
    | { protectionKind: "entity"; entityType: ProtectedRegistryEntityType }
    | { protectionKind: "literal"; entityType?: never }
  );

interface ProtectedRegistryEntryInputFields {
  id?: string;
  matterId: string;
  type: ProtectedRegistryEntryType;
  value: string;
  forms?: ProtectedRegistryEntryForm[];
  source?: ProtectedRegistryEntrySource;
  status?: ProtectedRegistryEntryStatus;
}

export type ProtectedRegistryEntryInput = ProtectedRegistryEntryInputFields &
  (
    | { protectionKind: "entity"; entityType: ProtectedRegistryEntityType }
    | { protectionKind: "literal"; entityType?: never }
  );

export const DEFAULT_SUGGESTED_PROMPTS = [
  "Summarize this document and flag anything that needs attention.",
  "Draft a polite reply to this email declining the request.",
  "Pull out the key dates, names, and action items from this text.",
  "Rewrite this in plain, clear language.",
];

export const SUGGESTED_PROMPT_MAX = 300;
export const SUGGESTED_PROMPTS_MAX = 12;

export function normalizeSuggestedPrompts(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("invalid suggestedPrompts");
  return input
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim().slice(0, SUGGESTED_PROMPT_MAX))
    .filter(Boolean)
    .slice(0, SUGGESTED_PROMPTS_MAX);
}

export function resolveSuggestedPrompts(instance: InstanceSettings): string[] {
  return instance.suggestedPrompts === undefined ? DEFAULT_SUGGESTED_PROMPTS : instance.suggestedPrompts;
}

/** A thread as shown in a history list — no messages, cheap to list. */
export interface ThreadSummary {
  id: string;
  title: string;
  /** Undefined on legacy chats until their model controls are next saved. */
  modelSettings?: ThreadModelSettings;
  /** Admin-controlled raw trace/audit capture for future requests in this thread. */
  traceEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A persisted chat message. `parts` is the TanStack AI `UIMessage.parts` array, stored opaque — we never
 * interpret it, just round-trip it through `initialMessages`. `id`/`role` are pulled out for indexing.
 */
export interface StoredMessage {
  id: string;
  role: "system" | "user" | "assistant";
  // Opaque UIMessage parts, round-tripped through jsonb. Typed `any[]` (not `unknown[]`) so the TanStack
  // server-fn boundary treats it as serializable — the shape is arbitrary but always JSON at runtime.
  parts: any[];
  createdAt?: string;
}

/** The stable key for a model choice, used by InstanceSettings.allowedModels and the ModelPicker filter. */
export function modelKey(m: { provider: string; model: string }): string {
  return `${m.provider}/${m.model}`;
}

/**
 * Whether a `"provider/model"` key is permitted by the instance allow-list. An undefined or empty list
 * means "no restriction" — every model is allowed. Used by the ModelPicker (filter) and api/chat.ts (403).
 */
export function isModelAllowed(instance: InstanceSettings, key: string): boolean {
  const allow = instance.allowedModels;
  return !allow || allow.length === 0 || allow.includes(key);
}
