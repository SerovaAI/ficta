import type { Provider } from "@/lib/models";
import type {
  EncryptedProviderKey,
  InstanceSettings,
  ProtectedRegistryEntry,
  ProtectedRegistryEntryInput,
  ProtectionStatsDailySummary,
  ProtectionStatsSnapshot,
  ProviderKeySummary,
  StoredMessage,
  ThreadEgressEvent,
  ThreadEgressReceipt,
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
  patchInstanceSettings(orgId: string, patch: Partial<InstanceSettings>): Promise<InstanceSettings>;

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
  getThread(
    userId: string,
    orgId: string,
    threadId: string,
  ): Promise<{ thread: ThreadSummary; messages: StoredMessage[] } | null>;
  /** Ownership probe used only by authenticated API boundaries; missing means a new draft id is available. */
  getThreadOwner(threadId: string): Promise<{ userId: string; orgId: string } | null>;
  /** Creates the thread if missing and upserts the initial user message without deleting later messages. */
  startThread(
    userId: string,
    orgId: string,
    threadId: string,
    message: StoredMessage,
    traceEnabled?: boolean,
  ): Promise<void>;
  /** Creates the thread if missing (title from the first user message), then snapshot-upserts messages. */
  saveThreadSnapshot(userId: string, orgId: string, threadId: string, messages: StoredMessage[]): Promise<void>;
  /** Admin-only server functions call this to mark future requests in a thread for raw trace/audit capture. */
  setThreadTraceEnabled(userId: string, orgId: string, threadId: string, traceEnabled: boolean): Promise<void>;
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
  if (!cached) cached = import("./drizzle/store.server").then((m) => m.createStorage());
  return cached;
}
