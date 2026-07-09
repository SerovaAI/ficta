import { date, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { InstanceSettings, ProtectionStatsTotals, UserSettings } from "../types";

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

/** A chat conversation. Id is client-generated (crypto.randomUUID) so a new chat has a stable id pre-save.
 * Scoped by both `userId` (private to its author) and `orgId` (the workspace it was created in). */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull().default("local"),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_scope_updated_idx").on(t.userId, t.orgId, t.updatedAt.desc())],
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
