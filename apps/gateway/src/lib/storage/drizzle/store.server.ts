import { and, asc, desc, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import type { Provider } from "@/lib/models";
import type { Storage } from "../storage.server";
import type {
  InstanceSettings,
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
  protectionStatsCheckpoints,
  protectionStatsDaily,
  providerKeys,
  threads,
  userSettings,
} from "./schema";

const TITLE_MAX = 80;
const PROTECTION_STATS_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

    async startThread(userId, orgId, threadId, message) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(threads).where(eq(threads.id, threadId));
        if (existing) {
          // A thread id is client-generated; refuse to write into someone else's thread or workspace.
          if (existing.userId !== userId || existing.orgId !== orgId) throw new Error("thread not found");
          await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
        } else {
          await tx.insert(threads).values({ id: threadId, userId, orgId, title: deriveTitle([message]) });
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
        .set({ title: title.slice(0, TITLE_MAX) || "New chat", updatedAt: new Date() })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
    },

    async deleteThread(userId, orgId, threadId) {
      const db = await getDb();
      // messages cascade via the FK.
      await db
        .delete(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
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

function toThreadSummary(row: { id: string; title: string; createdAt: Date; updatedAt: Date }): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** First user message's text, trimmed to a title. Falls back to the default when there's nothing to show. */
function deriveTitle(snapshot: StoredMessage[]): string {
  const firstUser = snapshot.find((m) => m.role === "user");
  const text = firstUser ? partsToText(firstUser.parts) : "";
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  return trimmed || "New chat";
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
