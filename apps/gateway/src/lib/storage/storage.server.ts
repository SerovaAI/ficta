import type { Provider } from "@/lib/models";
import type {
  EncryptedProviderKey,
  InstanceSettings,
  ProtectedRegistryEntry,
  ProtectedRegistryEntryInput,
  ProtectionStatsDailySummary,
  ProtectionStatsSnapshot,
  ProviderKeySummary,
  RecordsAccessReason,
  RecordsAuditEvent,
  RetainedThreadDetail,
  RetainedThreadSummary,
  RetentionSweepResult,
  StoredMessage,
  ThreadEgressEvent,
  ThreadEgressReceipt,
  ThreadModelSettings,
  ThreadSummary,
  UserSettings,
} from "./types";

export class ThreadProtectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadProtectionLimitError";
  }
}

/**
 * The persistence boundary seam. Everything that reads or writes durable state in apps/gateway — settings and
 * chat history — goes through a `Storage`, so the backend (Drizzle over PGlite/Postgres today, possibly
 * Convex later) lives behind this interface and no route or component imports a database driver directly.
 * It mirrors the auth `AuthProvider` seam (provider.server.ts): interface + a memoized `getStorage()`
 * resolver whose dynamic import keeps drizzle/pg/pglite out of the client bundle and out of any code path
 * that never touches storage.
 *
 * The methods are deliberately Convex-portable: all async, all params/returns plain JSON-serializable, and
 * the scope keys (`userId`, `orgId`) are always passed in (never read from ambient request state inside the
 * store). Adding Convex later is one branch here plus one implementation file — exactly like the auth seam.
 *
 * Scoping: `userId` owns per-user rows; `orgId` is the workspace (tenant) threads and instance settings are
 * partitioned by. User settings are personal and follow the user across workspaces, so they take only `userId`.
 *
 * Server-only: imported from server functions (settings.ts, threads.ts) and api/chat.ts, never a component.
 */
export interface Storage {
  getUserSettings(userId: string): Promise<UserSettings>;
  patchUserSettings(userId: string, patch: Partial<UserSettings>): Promise<UserSettings>;

  getInstanceSettings(orgId: string): Promise<InstanceSettings>;
  patchInstanceSettings(
    orgId: string,
    patch: Partial<InstanceSettings>,
    actorUserId?: string,
  ): Promise<InstanceSettings>;

  listProviderKeySummaries(orgId: string): Promise<ProviderKeySummary[]>;
  getProviderKey(orgId: string, provider: Provider): Promise<EncryptedProviderKey | null>;
  upsertProviderKey(orgId: string, key: EncryptedProviderKey): Promise<ProviderKeySummary>;
  deleteProviderKey(orgId: string, provider: Provider): Promise<void>;

  ingestProtectionStatsSnapshot(orgId: string, proxyUrl: string, snapshot: ProtectionStatsSnapshot): Promise<void>;
  listProtectionStatsDaily(orgId: string, days?: number): Promise<ProtectionStatsDailySummary[]>;
  appendThreadEgressEvent(
    userId: string,
    orgId: string,
    threadId: string,
    proof: Omit<ThreadEgressEvent, "threadId" | "previousHash" | "eventHash">,
  ): Promise<void>;
  getThreadEgressReceipt(userId: string, orgId: string, threadId: string): Promise<ThreadEgressReceipt>;
  listRecordsAuditEvents(orgId: string, threadId?: string): Promise<RecordsAuditEvent[]>;

  listProtectedRegistryEntries(orgId: string): Promise<ProtectedRegistryEntry[]>;
  upsertProtectedRegistryEntry(
    orgId: string,
    userId: string,
    entry: ProtectedRegistryEntryInput,
  ): Promise<ProtectedRegistryEntry>;
  importProtectedRegistryEntries(
    orgId: string,
    userId: string,
    entries: ProtectedRegistryEntryInput[],
  ): Promise<ProtectedRegistryEntry[]>;
  deleteProtectedRegistryEntry(orgId: string, id: string): Promise<void>;

  listThreadProtectedValues(userId: string, orgId: string, threadId: string): Promise<string[]>;
  addThreadProtectedValues(userId: string, orgId: string, threadId: string, values: string[]): Promise<string[]>;
  removeThreadProtectedValues(userId: string, orgId: string, threadId: string, values: string[]): Promise<string[]>;
  updateThreadProtectedValues(
    userId: string,
    orgId: string,
    threadId: string,
    changes: { add: string[]; remove: string[] },
  ): Promise<string[]>;
  pruneAbandonedThreadProtectedValues(userId: string, orgId: string): Promise<void>;

  listThreads(userId: string, orgId: string): Promise<ThreadSummary[]>;
  listRetainedThreads(orgId: string): Promise<RetainedThreadSummary[]>;
  getRetainedThread(
    orgId: string,
    actorUserId: string,
    threadId: string,
    reason: RecordsAccessReason,
  ): Promise<RetainedThreadDetail | null>;
  restoreRetainedThread(
    orgId: string,
    actorUserId: string,
    threadId: string,
    reason: RecordsAccessReason,
  ): Promise<void>;
  runRetentionSweep(now?: Date, batchSize?: number): Promise<RetentionSweepResult[]>;
  getThread(
    userId: string,
    orgId: string,
    threadId: string,
  ): Promise<{ thread: ThreadSummary; messages: StoredMessage[] } | null>;
  /** Ownership probe used only by authenticated API boundaries; missing means a new draft id is available.
   * `deleted` marks a retained (soft-deleted) thread, whose id must stay reserved but unusable. */
  getThreadOwner(threadId: string): Promise<{ userId: string; orgId: string; deleted: boolean } | null>;
  /** Creates the thread if missing and upserts the initial user message without deleting later messages. */
  startThread(
    userId: string,
    orgId: string,
    threadId: string,
    message: StoredMessage,
    traceEnabled?: boolean,
    modelSettings?: ThreadModelSettings,
    detectionJurisdictions?: string[],
  ): Promise<void>;
  /** Creates the thread if missing (including initial model settings), then snapshot-upserts messages. */
  saveThreadSnapshot(
    userId: string,
    orgId: string,
    threadId: string,
    messages: StoredMessage[],
    modelSettings?: ThreadModelSettings,
  ): Promise<void>;
  /** Persists composer model controls without reordering the chat in history. */
  setThreadModelSettings(
    userId: string,
    orgId: string,
    threadId: string,
    modelSettings: ThreadModelSettings,
  ): Promise<void>;
  /** Admin-only server functions call this to mark future requests in a thread for raw trace/audit capture. */
  setThreadTraceEnabled(userId: string, orgId: string, threadId: string, traceEnabled: boolean): Promise<void>;
  /** Persists the chat's detection-widening jurisdictions (empty clears). Owner-scoped like the other setters. */
  setThreadDetectionJurisdictions(
    userId: string,
    orgId: string,
    threadId: string,
    jurisdictions: string[],
  ): Promise<void>;
  renameThread(userId: string, orgId: string, threadId: string, title: string): Promise<void>;
  deleteThread(userId: string, orgId: string, threadId: string): Promise<void>;
}

let cached: Promise<Storage> | null = null;

/**
 * Resolve the storage backend once per process. Single backend today (Drizzle, with its own PGlite|Postgres
 * driver switch inside); when a second backend exists this grows an env-var branch exactly like
 * getActiveProvider(). The dynamic import already pays off now — it keeps the DB drivers out of every bundle
 * and code path that doesn't touch storage.
 */
export function getStorage(): Promise<Storage> {
  if (!cached) {
    cached = import("./drizzle/store.server").then((m) => m.createStorage());
    cached.then(startRetentionSweeps, () => {});
  }
  return cached;
}

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * In-process purge scheduler: runs once when storage first resolves and hourly after. Deliberately not an
 * operator cron — one long-lived gateway process per deployment makes this the simplest reliable home, and
 * a sweep failure must never take storage down with it, so errors are logged and retried next interval.
 */
function startRetentionSweeps(storage: Storage): void {
  const sweep = async () => {
    try {
      for (const run of await storage.runRetentionSweep()) {
        if (run.purgedThreads || run.purgedAuditEvents || run.purgedEgressEvents) {
          console.log(
            `retention sweep (${run.orgId}): purged ${run.purgedThreads} chats, ` +
              `${run.purgedAuditEvents} audit events, ${run.purgedEgressEvents} egress events`,
          );
        }
      }
    } catch (error) {
      console.error("deleted-chat retention sweep failed", error);
    }
  };
  void sweep();
  setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS).unref();
}
