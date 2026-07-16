import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type {
  InstanceSettings,
  ProtectedRegistryEntityType,
  ProtectedRegistryEntryForm,
  ProtectedRegistryEntryStatus,
  ProtectedRegistryEntryType,
  ProtectedRegistryProtectionKind,
  ProtectionStatsTotals,
  ThreadEgressEvent,
  ThreadModelSettings,
  UserSettings,
} from "../types";

/**
 * Postgres schema for the storage seam. One dialect only: PGlite (the zero-config default) and real
 * Postgres (via DATABASE_URL) speak the same SQL, so this file drives both. `drizzle-kit generate` reads
 * ONLY this module to emit migration SQL — it never connects to a database (see migrate.server.ts for how
 * the generated SQL is applied). Keep this file free of server-only side effects for that reason.
 *
 * There is deliberately no `users` table: the auth provider's user id is an opaque scoping string
 * (`AuthUser.id`, or the "local" sentinel in `none` mode), matching the AuthUser Convex-key intent.
 * The same holds for the org (tenant) scope: `orgId` is an opaque string — a WorkOS `org_...` id, a
 * `user:<id>` personal-workspace fallback, or "local" in `none` mode. No `organizations` table.
 */

/** One row per user; `data` is the whole UserSettings object (see D4 — typed jsonb, not KV rows). */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  data: jsonb("data").$type<UserSettings>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per workspace, keyed by `orgId` (the scope key — "local", a WorkOS org id, or `user:<id>`).
 * Admin settings are per-org, so org-mates share an instance name and model allow-list. */
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<InstanceSettings>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Workspace-scoped encrypted provider API keys. Plaintext keys never enter the database. */
export const providerKeys = pgTable(
  "provider_keys",
  {
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    keyHint: text("key_hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.provider] })],
);

/** Org-scoped values-free protection trend totals. One UTC day per row; no request or label metadata. */
export const protectionStatsDaily = pgTable(
  "protection_stats_daily",
  {
    orgId: text("org_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    events: integer("events").notNull().default(0),
    affectedRequests: integer("affected_requests").notNull().default(0),
    redactedValues: integer("redacted_values").notNull().default(0),
    survivingValues: integer("surviving_values").notNull().default(0),
    blockedRequests: integer("blocked_requests").notNull().default(0),
    keptOutOfModelValues: integer("kept_out_of_model_values").notNull().default(0),
    restoredValues: integer("restored_values").notNull().default(0),
    withheldFromToolsValues: integer("withheld_from_tools_values").notNull().default(0),
    ambiguousEntityLinks: integer("ambiguous_entity_links").notNull().default(0),
    ambiguousEntityLinkRequests: integer("ambiguous_entity_link_requests").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] }), index("protection_stats_daily_org_day_idx").on(t.orgId, t.day)],
);

/** Last cumulative proxy-run totals seen by Gateway, used to turn proxy snapshots into daily deltas. */
export const protectionStatsCheckpoints = pgTable(
  "protection_stats_checkpoints",
  {
    orgId: text("org_id").notNull(),
    proxyUrl: text("proxy_url").notNull(),
    proxyStartedAt: timestamp("proxy_started_at", { withTimezone: true }).notNull(),
    statsPath: text("stats_path").notNull(),
    lastTotals: jsonb("last_totals").$type<ProtectionStatsTotals>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.proxyUrl, t.proxyStartedAt, t.statsPath] }),
    index("protection_stats_checkpoints_updated_idx").on(t.orgId, t.updatedAt),
  ],
);

/** Workspace-scoped confidential entity protected registry. Approved rows are exported as exact-match registry
 * values for the proxy; suggested/ignored rows stay in the admin workflow until reviewed. */
export const protectedRegistryEntries = pgTable(
  "protected_registry_entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    matterId: text("matter_id").notNull().default(""),
    type: text("type").$type<ProtectedRegistryEntryType>().notNull(),
    protectionKind: text("protection_kind").$type<ProtectedRegistryProtectionKind>().notNull().default("literal"),
    entityType: text("entity_type").$type<ProtectedRegistryEntityType>(),
    value: text("value").notNull(),
    forms: jsonb("forms").$type<ProtectedRegistryEntryForm[]>().notNull().default([]),
    source: text("source").notNull().default("manual"),
    status: text("status").$type<ProtectedRegistryEntryStatus>().notNull().default("approved"),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("protected_registry_entries_scope_status_idx").on(t.orgId, t.status, t.updatedAt.desc()),
    index("protected_registry_entries_scope_matter_idx").on(t.orgId, t.matterId, t.type),
    check("protected_registry_entries_protection_kind_check", sql`${t.protectionKind} in ('literal', 'entity')`),
    check(
      "protected_registry_entries_entity_type_check",
      sql`${t.entityType} is null or ${t.entityType} in ('organization', 'person')`,
    ),
  ],
);

/** A chat conversation. Id is client-generated (crypto.randomUUID) so a new chat has a stable id pre-save.
 * Scoped by both `userId` (private to its author) and `orgId` (the workspace it was created in). */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull().default("local"),
    title: text("title").notNull().default("New chat"),
    /** Jurisdiction codes additively widening best-effort PII detection for this chat (see the
     * detection-profile header in the protocol package); null/empty = baseline only. */
    detectionJurisdictions: jsonb("detection_jurisdictions").$type<string[]>(),
    modelSettings: jsonb("model_settings").$type<ThreadModelSettings>(),
    traceEnabled: boolean("trace_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_scope_updated_idx").on(t.userId, t.orgId, t.updatedAt.desc())],
);

/** User-selected values remembered for one chat. Kept separate from the workspace registry so a chat
 * selection never silently becomes organization-wide policy, and so a not-yet-sent chat stays out of
 * the history list. Values are private application data, like the restored transcript itself. */
export const threadProtectedValues = pgTable(
  "thread_protected_values",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("thread_protected_values_scope_idx").on(t.userId, t.orgId, t.threadId)],
);

/**
 * One row per message (not a blob per thread) to leave search/pagination open later. `parts` is the
 * opaque UIMessage parts array; `orderIdx` is the message's position within the snapshot so ordering
 * survives a reload without relying on timestamps.
 */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
    orderIdx: integer("order_idx").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.orderIdx)],
);

/**
 * Values-free audit evidence, append-only by application contract. This deliberately has no foreign
 * key to `threads`: deleting a chat transcript must not silently erase its egress evidence.
 */
export const threadEgressEvents = pgTable(
  "thread_egress_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    threadId: text("thread_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<ThreadEgressEvent["outcome"]>().notNull(),
    screening: text("screening").$type<ThreadEgressEvent["screening"]>().notNull(),
    model: text("model").notNull(),
    redactedValues: integer("redacted_values").notNull(),
    survivingValues: integer("surviving_values").notNull(),
    ambiguousEntityLinks: integer("ambiguous_entity_links").notNull().default(0),
    labels: jsonb("labels").$type<ThreadEgressEvent["labels"]>().notNull().default([]),
    previousHash: text("previous_hash"),
    eventHash: text("event_hash").notNull(),
  },
  (t) => [index("thread_egress_events_scope_thread_idx").on(t.userId, t.orgId, t.threadId, t.occurredAt.desc())],
);
