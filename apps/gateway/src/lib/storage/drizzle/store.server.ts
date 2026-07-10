import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Provider } from "@/lib/models";
import { deriveThreadTitleFromText, THREAD_TITLE_MAX } from "@/lib/thread-title";
import { type Storage, ThreadProtectionLimitError } from "../storage.server";
import type {
  InstanceSettings,
  ProtectedRegistryEntry,
  ProtectionStatsDailySummary,
  ProtectionStatsTotals,
  ProviderKeySummary,
  StoredMessage,
  ThreadSummary,
  UserSettings,
} from "../types";
import { getDb } from "./client.server";
import {
  instanceSettings,
  messages,
  protectedRegistryEntries,
  protectionStatsCheckpoints,
  protectionStatsDaily,
  providerKeys,
  threadProtectedValues,
  threads,
  userSettings,
} from "./schema";

const PROTECTION_STATS_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const THREAD_PROTECTED_VALUES_MAX = 200;
const THREAD_PROTECTED_VALUE_MAX = 2_000;
const ABANDONED_PROTECTION_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * The Drizzle-backed `Storage` implementation. Speaks the schema in schema.ts; the actual driver (PGlite
 * or node-postgres) is chosen inside getDb(). Nothing here is driver-specific — the same code runs against
 * both. Every method takes its scope keys (`userId`, `orgId`) explicitly and never reads ambient request
 * state, keeping the store a pure repository (and Convex-portable).
 */
export function createStorage(): Storage {
  return {
    async getUserSettings(userId) {
      const db = await getDb();
      const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      return row?.data ?? {};
    },

    async patchUserSettings(userId, patch) {
      const db = await getDb();
      const current = await this.getUserSettings(userId);
      const next: UserSettings = { ...current, ...patch };
      await db
        .insert(userSettings)
        .values({ userId, data: next })
        .onConflictDoUpdate({ target: userSettings.userId, set: { data: next, updatedAt: new Date() } });
      return next;
    },

    async getInstanceSettings(orgId) {
      const db = await getDb();
      const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, orgId));
      return row?.data ?? {};
    },

    async patchInstanceSettings(orgId, patch) {
      const db = await getDb();
      const current = await this.getInstanceSettings(orgId);
      const next: InstanceSettings = { ...current, ...patch };
      await db
        .insert(instanceSettings)
        .values({ id: orgId, data: next })
        .onConflictDoUpdate({ target: instanceSettings.id, set: { data: next, updatedAt: new Date() } });
      return next;
    },

    async listProviderKeySummaries(orgId) {
      const db = await getDb();
      const rows = await db.select().from(providerKeys).where(eq(providerKeys.orgId, orgId));
      return rows.map(toProviderKeySummary);
    },

    async getProviderKey(orgId, provider) {
      const db = await getDb();
      const [row] = await db
        .select()
        .from(providerKeys)
        .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.provider, provider)));
      if (!row) return null;
      return {
        provider: row.provider as Provider,
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        keyHint: row.keyHint,
      };
    },

    async upsertProviderKey(orgId, key) {
      const db = await getDb();
      const now = new Date();
      const [row] = await db
        .insert(providerKeys)
        .values({
          orgId,
          provider: key.provider,
          ciphertext: key.ciphertext,
          iv: key.iv,
          tag: key.tag,
          keyHint: key.keyHint,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [providerKeys.orgId, providerKeys.provider],
          set: {
            ciphertext: key.ciphertext,
            iv: key.iv,
            tag: key.tag,
            keyHint: key.keyHint,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) throw new Error("provider key was not saved");
      return toProviderKeySummary(row);
    },

    async deleteProviderKey(orgId, provider) {
      const db = await getDb();
      await db.delete(providerKeys).where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.provider, provider)));
    },

    async ingestProtectionStatsSnapshot(orgId, proxyUrl, snapshot) {
      const db = await getDb();
      const proxyStartedAt = new Date(snapshot.startedAt);
      if (Number.isNaN(proxyStartedAt.valueOf())) return;
      const now = new Date();
      const day = utcDay(snapshot.updatedAt, now);
      const cutoffDay = retentionCutoffDay(PROTECTION_STATS_RETENTION_DAYS, now);
      const checkpointCutoff = new Date(now.getTime() - PROTECTION_STATS_RETENTION_DAYS * MS_PER_DAY);

      await db.transaction(async (tx) => {
        const [checkpoint] = await tx
          .select()
          .from(protectionStatsCheckpoints)
          .where(
            and(
              eq(protectionStatsCheckpoints.orgId, orgId),
              eq(protectionStatsCheckpoints.proxyUrl, proxyUrl),
              eq(protectionStatsCheckpoints.proxyStartedAt, proxyStartedAt),
              eq(protectionStatsCheckpoints.statsPath, snapshot.path),
            ),
          );
        const delta = protectionStatsDelta(snapshot.totals, checkpoint?.lastTotals);

        await tx
          .insert(protectionStatsCheckpoints)
          .values({
            orgId,
            proxyUrl,
            proxyStartedAt,
            statsPath: snapshot.path,
            lastTotals: snapshot.totals,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              protectionStatsCheckpoints.orgId,
              protectionStatsCheckpoints.proxyUrl,
              protectionStatsCheckpoints.proxyStartedAt,
              protectionStatsCheckpoints.statsPath,
            ],
            set: { lastTotals: snapshot.totals, updatedAt: now },
          });

        if (hasProtectionStatsDelta(delta)) {
          await tx
            .insert(protectionStatsDaily)
            .values({ orgId, day, ...delta, updatedAt: now })
            .onConflictDoUpdate({
              target: [protectionStatsDaily.orgId, protectionStatsDaily.day],
              set: {
                events: sql`${protectionStatsDaily.events} + ${delta.events}`,
                affectedRequests: sql`${protectionStatsDaily.affectedRequests} + ${delta.affectedRequests}`,
                redactedValues: sql`${protectionStatsDaily.redactedValues} + ${delta.redactedValues}`,
                survivingValues: sql`${protectionStatsDaily.survivingValues} + ${delta.survivingValues}`,
                blockedRequests: sql`${protectionStatsDaily.blockedRequests} + ${delta.blockedRequests}`,
                keptOutOfModelValues: sql`${protectionStatsDaily.keptOutOfModelValues} + ${delta.keptOutOfModelValues}`,
                restoredValues: sql`${protectionStatsDaily.restoredValues} + ${delta.restoredValues}`,
                withheldFromToolsValues: sql`${protectionStatsDaily.withheldFromToolsValues} + ${delta.withheldFromToolsValues}`,
                updatedAt: now,
              },
            });
        }

        await tx
          .delete(protectionStatsDaily)
          .where(and(eq(protectionStatsDaily.orgId, orgId), lt(protectionStatsDaily.day, cutoffDay)));
        await tx
          .delete(protectionStatsCheckpoints)
          .where(
            and(
              eq(protectionStatsCheckpoints.orgId, orgId),
              lt(protectionStatsCheckpoints.updatedAt, checkpointCutoff),
            ),
          );
      });
    },

    async listProtectionStatsDaily(orgId, days = PROTECTION_STATS_RETENTION_DAYS) {
      const db = await getDb();
      const cutoffDay = retentionCutoffDay(days);
      const rows = await db
        .select()
        .from(protectionStatsDaily)
        .where(and(eq(protectionStatsDaily.orgId, orgId), gte(protectionStatsDaily.day, cutoffDay)))
        .orderBy(asc(protectionStatsDaily.day));
      return rows.map(toProtectionStatsDailySummary);
    },

    async listProtectedRegistryEntries(orgId) {
      const db = await getDb();
      const rows = await db
        .select()
        .from(protectedRegistryEntries)
        .where(eq(protectedRegistryEntries.orgId, orgId))
        .orderBy(
          asc(protectedRegistryEntries.matterId),
          asc(protectedRegistryEntries.type),
          asc(protectedRegistryEntries.value),
        );
      return rows.map(toProtectedRegistryEntry);
    },

    async upsertProtectedRegistryEntry(orgId, userId, entry) {
      const db = await getDb();
      const now = new Date();
      const id = entry.id || randomUUID();
      const current = entry.id
        ? (
            await db
              .select()
              .from(protectedRegistryEntries)
              .where(and(eq(protectedRegistryEntries.orgId, orgId), eq(protectedRegistryEntries.id, entry.id)))
          )[0]
        : undefined;
      if (entry.id && !current) throw new Error("protected registry entry not found");
      const status = entry.status ?? "approved";
      const approvedAt = status === "approved" ? (current?.approvedAt ?? now) : null;
      const approvedBy = status === "approved" ? (current?.approvedBy ?? userId) : null;
      const [row] = await db
        .insert(protectedRegistryEntries)
        .values({
          id,
          orgId,
          matterId: entry.matterId,
          type: entry.type,
          value: entry.value,
          aliases: entry.aliases ?? [],
          source: entry.source ?? "manual",
          status,
          createdBy: current?.createdBy ?? userId,
          approvedBy,
          approvedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: protectedRegistryEntries.id,
          set: {
            matterId: entry.matterId,
            type: entry.type,
            value: entry.value,
            aliases: entry.aliases ?? [],
            source: entry.source ?? "manual",
            status,
            approvedBy,
            approvedAt,
            updatedAt: now,
          },
        })
        .returning();
      if (!row || row.orgId !== orgId) throw new Error("protected registry entry was not saved");
      return toProtectedRegistryEntry(row);
    },

    async importProtectedRegistryEntries(orgId, userId, entries) {
      const db = await getDb();
      const now = new Date();
      const saved: ProtectedRegistryEntry[] = [];
      await db.transaction(async (tx) => {
        for (const entry of entries) {
          const status = entry.status ?? "approved";
          const approved = status === "approved";
          const [row] = await tx
            .insert(protectedRegistryEntries)
            .values({
              id: randomUUID(),
              orgId,
              matterId: entry.matterId,
              type: entry.type,
              value: entry.value,
              aliases: entry.aliases ?? [],
              source: entry.source ?? "csv",
              status,
              createdBy: userId,
              approvedBy: approved ? userId : null,
              approvedAt: approved ? now : null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (row) saved.push(toProtectedRegistryEntry(row));
        }
      });
      return saved;
    },

    async deleteProtectedRegistryEntry(orgId, id) {
      const db = await getDb();
      await db
        .delete(protectedRegistryEntries)
        .where(and(eq(protectedRegistryEntries.orgId, orgId), eq(protectedRegistryEntries.id, id)));
    },

    async listThreadProtectedValues(userId, orgId, threadId) {
      const db = await getDb();
      const rows = await db
        .select({ value: threadProtectedValues.value })
        .from(threadProtectedValues)
        .where(
          and(
            eq(threadProtectedValues.userId, userId),
            eq(threadProtectedValues.orgId, orgId),
            eq(threadProtectedValues.threadId, threadId),
          ),
        )
        .orderBy(asc(threadProtectedValues.createdAt));
      return rows.map((row) => row.value);
    },

    async addThreadProtectedValues(userId, orgId, threadId, values) {
      return this.updateThreadProtectedValues(userId, orgId, threadId, { add: values, remove: [] });
    },

    async removeThreadProtectedValues(userId, orgId, threadId, values) {
      return this.updateThreadProtectedValues(userId, orgId, threadId, { add: [], remove: values });
    },

    async updateThreadProtectedValues(userId, orgId, threadId, changes) {
      const db = await getDb();
      const additions = [...new Set(changes.add.map((value) => value.trim()).filter(Boolean))];
      const removals = [...new Set(changes.remove.map((value) => value.trim()).filter(Boolean))];
      if (additions.some((value) => value.length > THREAD_PROTECTED_VALUE_MAX)) {
        throw new ThreadProtectionLimitError("A chat-protected value is too long.");
      }
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ value: threadProtectedValues.value })
          .from(threadProtectedValues)
          .where(
            and(
              eq(threadProtectedValues.userId, userId),
              eq(threadProtectedValues.orgId, orgId),
              eq(threadProtectedValues.threadId, threadId),
            ),
          )
          .orderBy(asc(threadProtectedValues.createdAt));
        const known = new Set(rows.map((row) => row.value));
        for (const value of removals) known.delete(value);
        for (const value of additions) known.add(value);
        if (known.size > THREAD_PROTECTED_VALUES_MAX) {
          throw new ThreadProtectionLimitError(`Protect at most ${THREAD_PROTECTED_VALUES_MAX} values in one chat.`);
        }
        if (removals.length > 0) {
          await tx
            .delete(threadProtectedValues)
            .where(
              and(
                eq(threadProtectedValues.userId, userId),
                eq(threadProtectedValues.orgId, orgId),
                eq(threadProtectedValues.threadId, threadId),
                inArray(threadProtectedValues.value, removals),
              ),
            );
        }
        const existing = new Set(rows.map((row) => row.value).filter((value) => !removals.includes(value)));
        for (const value of additions) {
          if (existing.has(value)) continue;
          await tx.insert(threadProtectedValues).values({ id: randomUUID(), userId, orgId, threadId, value });
          existing.add(value);
        }
        return [...known];
      });
    },

    async pruneAbandonedThreadProtectedValues(userId, orgId) {
      const db = await getDb();
      await db
        .delete(threadProtectedValues)
        .where(
          and(
            eq(threadProtectedValues.userId, userId),
            eq(threadProtectedValues.orgId, orgId),
            lt(threadProtectedValues.createdAt, new Date(Date.now() - ABANDONED_PROTECTION_RETENTION_MS)),
            notInArray(threadProtectedValues.threadId, db.select({ id: threads.id }).from(threads)),
          ),
        );
    },

    async listThreads(userId, orgId) {
      const db = await getDb();
      const rows = await db
        .select()
        .from(threads)
        .where(and(eq(threads.userId, userId), eq(threads.orgId, orgId)))
        .orderBy(desc(threads.updatedAt));
      return rows.map(toThreadSummary);
    },

    async getThread(userId, orgId, threadId) {
      const db = await getDb();
      const [thread] = await db
        .select()
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
      if (!thread) return null;
      const rows = await db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(messages.orderIdx);
      return {
        thread: toThreadSummary(thread),
        messages: rows.map(
          (r): StoredMessage => ({
            id: r.id,
            role: r.role as StoredMessage["role"],
            parts: r.parts as StoredMessage["parts"],
            createdAt: r.createdAt.toISOString(),
          }),
        ),
      };
    },

    async getThreadOwner(threadId) {
      const db = await getDb();
      const [thread] = await db
        .select({ userId: threads.userId, orgId: threads.orgId })
        .from(threads)
        .where(eq(threads.id, threadId));
      return thread ?? null;
    },

    async startThread(userId, orgId, threadId, message, traceEnabled = false) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(threads).where(eq(threads.id, threadId));
        if (existing) {
          // A thread id is client-generated; refuse to write into someone else's thread or workspace.
          if (existing.userId !== userId || existing.orgId !== orgId) throw new Error("thread not found");
          await tx
            .update(threads)
            .set({ updatedAt: new Date(), ...(traceEnabled ? { traceEnabled: true } : {}) })
            .where(eq(threads.id, threadId));
        } else {
          await tx.insert(threads).values({ id: threadId, userId, orgId, title: deriveTitle([message]), traceEnabled });
        }

        await tx
          .insert(messages)
          .values({ id: message.id, threadId, role: message.role, parts: message.parts, orderIdx: 0 })
          .onConflictDoUpdate({
            target: messages.id,
            set: { parts: message.parts, orderIdx: 0, role: message.role },
          });
      });
    },

    async saveThreadSnapshot(userId, orgId, threadId, snapshot) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(threads).where(eq(threads.id, threadId));
        if (existing) {
          // A thread id is client-generated; refuse to write into someone else's thread or workspace.
          if (existing.userId !== userId || existing.orgId !== orgId) throw new Error("thread not found");
          await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
        } else {
          await tx.insert(threads).values({ id: threadId, userId, orgId, title: deriveTitle(snapshot) });
        }

        // Snapshot semantics: the incoming list is the whole truth. Drop rows it no longer contains
        // (covers a client-side regenerate that replaces the trailing assistant message), upsert the rest.
        const ids = snapshot.map((m) => m.id);
        await tx
          .delete(messages)
          .where(
            ids.length
              ? and(eq(messages.threadId, threadId), notInArray(messages.id, ids))
              : eq(messages.threadId, threadId),
          );

        for (const [orderIdx, m] of snapshot.entries()) {
          await tx
            .insert(messages)
            .values({ id: m.id, threadId, role: m.role, parts: m.parts, orderIdx })
            .onConflictDoUpdate({
              target: messages.id,
              set: { parts: m.parts, orderIdx, role: m.role },
            });
        }
      });
    },

    async renameThread(userId, orgId, threadId, title) {
      const db = await getDb();
      await db
        .update(threads)
        .set({ title: title.slice(0, THREAD_TITLE_MAX) || "New chat", updatedAt: new Date() })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
    },

    async setThreadTraceEnabled(userId, orgId, threadId, traceEnabled) {
      const db = await getDb();
      const updated = await db
        .update(threads)
        .set({ traceEnabled, updatedAt: new Date() })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)))
        .returning();
      if (updated.length === 0) throw new Error("thread not found");
    },

    async deleteThread(userId, orgId, threadId) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await tx
          .delete(threadProtectedValues)
          .where(
            and(
              eq(threadProtectedValues.threadId, threadId),
              eq(threadProtectedValues.userId, userId),
              eq(threadProtectedValues.orgId, orgId),
            ),
          );
        // messages cascade via the FK.
        await tx
          .delete(threads)
          .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
      });
    },
  };
}

function protectionStatsDelta(
  current: ProtectionStatsTotals,
  previous: ProtectionStatsTotals | undefined,
): ProtectionStatsTotals {
  if (!previous) return { ...current };
  return {
    events: positiveDelta(current.events, previous.events),
    affectedRequests: positiveDelta(current.affectedRequests, previous.affectedRequests),
    redactedValues: positiveDelta(current.redactedValues, previous.redactedValues),
    survivingValues: positiveDelta(current.survivingValues, previous.survivingValues),
    blockedRequests: positiveDelta(current.blockedRequests, previous.blockedRequests),
    keptOutOfModelValues: positiveDelta(current.keptOutOfModelValues, previous.keptOutOfModelValues),
    restoredValues: positiveDelta(current.restoredValues, previous.restoredValues),
    withheldFromToolsValues: positiveDelta(current.withheldFromToolsValues, previous.withheldFromToolsValues),
  };
}

function positiveDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function hasProtectionStatsDelta(delta: ProtectionStatsTotals): boolean {
  return Object.values(delta).some((value) => value > 0);
}

function toProtectionStatsDailySummary(row: typeof protectionStatsDaily.$inferSelect): ProtectionStatsDailySummary {
  return {
    day: row.day,
    events: row.events,
    affectedRequests: row.affectedRequests,
    redactedValues: row.redactedValues,
    survivingValues: row.survivingValues,
    blockedRequests: row.blockedRequests,
    keptOutOfModelValues: row.keptOutOfModelValues,
    restoredValues: row.restoredValues,
    withheldFromToolsValues: row.withheldFromToolsValues,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function utcDay(input: string, fallback = new Date()): string {
  const date = new Date(input);
  return isoDay(Number.isNaN(date.valueOf()) ? fallback : date);
}

function retentionCutoffDay(days: number, now = new Date()): string {
  const normalized = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : PROTECTION_STATS_RETENTION_DAYS;
  return isoDay(new Date(now.getTime() - (normalized - 1) * MS_PER_DAY));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toProviderKeySummary(row: { provider: string; keyHint: string; updatedAt: Date }): ProviderKeySummary {
  return {
    provider: row.provider as Provider,
    configured: true,
    keyHint: row.keyHint,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProtectedRegistryEntry(row: {
  id: string;
  matterId: string;
  type: ProtectedRegistryEntry["type"];
  value: string;
  aliases: string[];
  source: string;
  status: ProtectedRegistryEntry["status"];
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ProtectedRegistryEntry {
  return {
    id: row.id,
    matterId: row.matterId,
    type: row.type,
    value: row.value,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    source: row.source === "csv" || row.source === "suggested" ? row.source : "manual",
    status: row.status,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy ?? undefined,
    approvedAt: row.approvedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toThreadSummary(row: {
  id: string;
  title: string;
  traceEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    traceEnabled: row.traceEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** First user message's text, trimmed to a title. Falls back to the default when there's nothing to show. */
function deriveTitle(snapshot: StoredMessage[]): string {
  const firstUser = snapshot.find((m) => m.role === "user");
  const text = firstUser ? partsToText(firstUser.parts) : "";
  return deriveThreadTitleFromText(text);
}

/** Pull plain text out of the opaque UIMessage parts, ignoring other part types. The live SDK's text part
 * is `{ type: "text", content }`; `text` is accepted as a fallback for any older/hand-built shape. */
function partsToText(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "text") return "";
      const part = p as { content?: unknown; text?: unknown };
      return String(part.content ?? part.text ?? "");
    })
    .join("");
}
