// Drive the storage seam against an in-memory PGlite through the REAL getStorage()/getDb() path, which
// also exercises the migration applier (migrate.server.ts) on boot. `memory://` makes PGlite ephemeral;
// setting it before any import that touches the DB is what routes create() to an in-memory instance.
process.env.FICTA_GATEWAY_DATA_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, describe, expect, it } from "vitest";
import type { Storage } from "@/lib/storage/storage.server";
import { getStorage } from "@/lib/storage/storage.server";
import type {
  EncryptedProviderKey,
  ProtectedRegistryEntryInput,
  ProtectionStatsSnapshot,
  ProtectionStatsTotals,
  StoredMessage,
} from "@/lib/storage/types";

let store: Storage;

beforeAll(async () => {
  store = await getStorage();
});

const textMessage = (id: string, role: StoredMessage["role"], text: string): StoredMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("user settings", () => {
  it("returns {} for an unknown user and merges patches", async () => {
    expect(await store.getUserSettings("u-new")).toEqual({});

    const first = await store.patchUserSettings("u-1", { defaultModel: { provider: "openai", model: "gpt-5" } });
    expect(first.defaultModel).toEqual({ provider: "openai", model: "gpt-5" });

    const withReasoning = await store.patchUserSettings("u-1", { defaultReasoningEffort: "high" });
    expect(withReasoning.defaultModel).toEqual({ provider: "openai", model: "gpt-5" });
    expect(withReasoning.defaultReasoningEffort).toBe("high");

    // A patch merges over the stored object rather than replacing it.
    const second = await store.patchUserSettings("u-1", {});
    expect(second.defaultModel).toEqual({ provider: "openai", model: "gpt-5" });
    expect(second.defaultReasoningEffort).toBe("high");
    expect(await store.getUserSettings("u-1")).toEqual(second);
  });

  it("scopes settings per user", async () => {
    await store.patchUserSettings("u-a", { defaultModel: { provider: "anthropic", model: "claude-sonnet-4-6" } });
    expect(await store.getUserSettings("u-b")).toEqual({});
  });
});

const ORG = "local";

describe("instance settings", () => {
  it("is one row per workspace that merges patches", async () => {
    expect(await store.getInstanceSettings(ORG)).toEqual({});
    await store.patchInstanceSettings(ORG, { instanceName: "Acme" });
    await store.patchInstanceSettings(ORG, { allowedModels: ["openai/gpt-5"] });
    await store.patchInstanceSettings(ORG, { suggestedPrompts: ["Summarize this."] });
    expect(await store.getInstanceSettings(ORG)).toEqual({
      instanceName: "Acme",
      allowedModels: ["openai/gpt-5"],
      suggestedPrompts: ["Summarize this."],
    });
  });

  it("isolates settings per workspace (org)", async () => {
    await store.patchInstanceSettings("org-x", { instanceName: "X" });
    await store.patchInstanceSettings("org-y", { instanceName: "Y" });
    expect((await store.getInstanceSettings("org-x")).instanceName).toBe("X");
    expect((await store.getInstanceSettings("org-y")).instanceName).toBe("Y");
  });
});

const encryptedKey = (provider: EncryptedProviderKey["provider"], value: string): EncryptedProviderKey => ({
  provider,
  ciphertext: `cipher-${value}`,
  iv: `iv-${value}`,
  tag: `tag-${value}`,
  keyHint: "...test",
});

describe("provider keys", () => {
  it("upserts encrypted provider keys and returns summary metadata only", async () => {
    await store.upsertProviderKey(ORG, encryptedKey("openai", "one"));
    await store.upsertProviderKey(ORG, encryptedKey("openai", "two"));

    const saved = await store.getProviderKey(ORG, "openai");
    expect(saved?.ciphertext).toBe("cipher-two");

    const summaries = await store.listProviderKeySummaries(ORG);
    expect(summaries).toEqual([
      expect.objectContaining({
        provider: "openai",
        configured: true,
        keyHint: "...test",
      }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain("cipher-two");
    expect(JSON.stringify(summaries)).not.toContain("tag-two");
  });

  it("isolates provider keys per workspace", async () => {
    await store.upsertProviderKey("org-key-a", encryptedKey("anthropic", "a"));
    await store.upsertProviderKey("org-key-b", encryptedKey("anthropic", "b"));

    expect((await store.getProviderKey("org-key-a", "anthropic"))?.ciphertext).toBe("cipher-a");
    expect((await store.getProviderKey("org-key-b", "anthropic"))?.ciphertext).toBe("cipher-b");
    expect(await store.getProviderKey("org-key-a", "openai")).toBeNull();
  });

  it("deletes a provider key within one workspace", async () => {
    await store.upsertProviderKey("org-delete", encryptedKey("openai", "delete"));
    await store.deleteProviderKey("org-delete", "openai");

    expect(await store.getProviderKey("org-delete", "openai")).toBeNull();
  });
});

const zeroTotals = (): ProtectionStatsTotals => ({
  events: 0,
  affectedRequests: 0,
  redactedValues: 0,
  survivingValues: 0,
  blockedRequests: 0,
  keptOutOfModelValues: 0,
  restoredValues: 0,
  withheldFromToolsValues: 0,
});

const totals = (patch: Partial<ProtectionStatsTotals>): ProtectionStatsTotals => ({ ...zeroTotals(), ...patch });

function protectionSnapshot(
  startedAt: string,
  updatedAt: string,
  patch: Partial<ProtectionStatsTotals>,
): ProtectionStatsSnapshot {
  return {
    version: 1,
    path: "/tmp/ficta/run-a/stats.json",
    startedAt,
    updatedAt,
    totals: totals(patch),
    byModel: [],
    bySurface: [],
    byWire: [],
    byLabel: [],
    events: [],
  };
}

describe("protection stats trends", () => {
  it("stores cumulative proxy snapshots as daily deltas", async () => {
    const orgId = "org-proof-delta";
    const proxyUrl = "http://127.0.0.1:8787";
    const now = new Date();
    const startedAt = now.toISOString();
    const updatedAt = new Date(now.getTime() + 1_000).toISOString();
    const dayKey = updatedAt.slice(0, 10);

    await store.ingestProtectionStatsSnapshot(
      orgId,
      proxyUrl,
      protectionSnapshot(startedAt, updatedAt, {
        events: 3,
        affectedRequests: 1,
        redactedValues: 3,
        keptOutOfModelValues: 3,
        restoredValues: 2,
      }),
    );

    await store.ingestProtectionStatsSnapshot(
      orgId,
      proxyUrl,
      protectionSnapshot(startedAt, new Date(now.getTime() + 2_000).toISOString(), {
        events: 5,
        affectedRequests: 2,
        redactedValues: 6,
        keptOutOfModelValues: 6,
        restoredValues: 4,
      }),
    );

    const [day] = await store.listProtectionStatsDaily(orgId);
    expect(day).toMatchObject({
      day: dayKey,
      events: 5,
      affectedRequests: 2,
      redactedValues: 6,
      keptOutOfModelValues: 6,
      restoredValues: 4,
    });
  });

  it("does not double-count repeated snapshots or subtract counter regressions", async () => {
    const orgId = "org-proof-regression";
    const proxyUrl = "http://127.0.0.1:8787";
    const now = new Date();
    const startedAt = now.toISOString();
    const first = protectionSnapshot(startedAt, new Date(now.getTime() + 1_000).toISOString(), {
      events: 4,
      affectedRequests: 2,
      redactedValues: 4,
      keptOutOfModelValues: 4,
    });

    await store.ingestProtectionStatsSnapshot(orgId, proxyUrl, first);
    await store.ingestProtectionStatsSnapshot(orgId, proxyUrl, first);
    await store.ingestProtectionStatsSnapshot(
      orgId,
      proxyUrl,
      protectionSnapshot(startedAt, new Date(now.getTime() + 2_000).toISOString(), {
        events: 3,
        affectedRequests: 1,
        redactedValues: 3,
        keptOutOfModelValues: 3,
      }),
    );

    const [day] = await store.listProtectionStatsDaily(orgId);
    expect(day).toMatchObject({
      events: 4,
      affectedRequests: 2,
      redactedValues: 4,
      keptOutOfModelValues: 4,
    });
  });

  it("treats a proxy restart as a new baseline", async () => {
    const orgId = "org-proof-restart";
    const proxyUrl = "http://127.0.0.1:8787";
    const now = new Date();
    await store.ingestProtectionStatsSnapshot(
      orgId,
      proxyUrl,
      protectionSnapshot(now.toISOString(), new Date(now.getTime() + 1_000).toISOString(), {
        events: 2,
        affectedRequests: 1,
        redactedValues: 2,
        keptOutOfModelValues: 2,
      }),
    );
    await store.ingestProtectionStatsSnapshot(
      orgId,
      proxyUrl,
      protectionSnapshot(new Date(now.getTime() + 2_000).toISOString(), new Date(now.getTime() + 3_000).toISOString(), {
        events: 3,
        affectedRequests: 1,
        redactedValues: 3,
        keptOutOfModelValues: 3,
      }),
    );

    const [day] = await store.listProtectionStatsDaily(orgId);
    expect(day).toMatchObject({ events: 5, affectedRequests: 2, redactedValues: 5, keptOutOfModelValues: 5 });
  });

  it("scopes daily trends by org and drops rows outside retention", async () => {
    const proxyUrl = "http://127.0.0.1:8787";
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const current = now.toISOString();

    await store.ingestProtectionStatsSnapshot(
      "org-proof-retention",
      proxyUrl,
      protectionSnapshot(new Date(now.getTime() + 1_000).toISOString(), old, {
        events: 9,
        affectedRequests: 9,
        redactedValues: 9,
        keptOutOfModelValues: 9,
      }),
    );
    await store.ingestProtectionStatsSnapshot(
      "org-proof-retention",
      proxyUrl,
      protectionSnapshot(new Date(now.getTime() + 2_000).toISOString(), current, {
        events: 1,
        affectedRequests: 1,
        redactedValues: 1,
        keptOutOfModelValues: 1,
      }),
    );
    await store.ingestProtectionStatsSnapshot(
      "org-proof-other",
      proxyUrl,
      protectionSnapshot(new Date(now.getTime() + 2_000).toISOString(), current, {
        events: 7,
        affectedRequests: 7,
        redactedValues: 7,
        keptOutOfModelValues: 7,
      }),
    );

    const retained = await store.listProtectionStatsDaily("org-proof-retention");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ events: 1, affectedRequests: 1, redactedValues: 1 });
    expect(await store.listProtectionStatsDaily("org-proof-missing")).toEqual([]);
  });
});

const protectedRegistryInput = (
  value: string,
  patch: Partial<ProtectedRegistryEntryInput> = {},
): ProtectedRegistryEntryInput => ({
  matterId: "NSB-2026-0147",
  type: "client",
  value,
  aliases: [],
  status: "approved",
  source: "manual",
  ...patch,
});

describe("confidential protected registry", () => {
  it("imports, updates, and deletes workspace protected registry entries", async () => {
    const imported = await store.importProtectedRegistryEntries("org-protected-registry", "admin-1", [
      protectedRegistryInput("Northstar Biologics (Pty) Ltd", { aliases: ["Northstar", "NBL"], source: "csv" }),
      protectedRegistryInput("Proxima Medical Supplies CC", {
        type: "counterparty",
        status: "suggested",
        source: "csv",
      }),
    ]);

    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      matterId: "NSB-2026-0147",
      type: "client",
      value: "Northstar Biologics (Pty) Ltd",
      aliases: ["Northstar", "NBL"],
      status: "approved",
      source: "csv",
      createdBy: "admin-1",
      approvedBy: "admin-1",
    });
    expect(imported[0]?.approvedAt).toBeTruthy();
    expect(imported[1]?.approvedAt).toBeUndefined();

    const updated = await store.upsertProtectedRegistryEntry("org-protected-registry", "admin-2", {
      ...protectedRegistryInput("Proxima Medical Supplies CC", {
        id: imported[1]?.id,
        type: "counterparty",
        aliases: ["Proxima"],
      }),
      status: "approved",
    });
    expect(updated.status).toBe("approved");
    expect(updated.approvedBy).toBe("admin-2");

    const listed = await store.listProtectedRegistryEntries("org-protected-registry");
    expect(listed.map((entry) => entry.value)).toEqual([
      "Northstar Biologics (Pty) Ltd",
      "Proxima Medical Supplies CC",
    ]);

    await store.deleteProtectedRegistryEntry("org-protected-registry", imported[0]?.id ?? "");
    expect((await store.listProtectedRegistryEntries("org-protected-registry")).map((entry) => entry.value)).toEqual([
      "Proxima Medical Supplies CC",
    ]);
  });

  it("isolates protected registry entries per workspace", async () => {
    await store.importProtectedRegistryEntries("org-protected-registry-a", "admin", [
      protectedRegistryInput("A Client"),
    ]);
    await store.importProtectedRegistryEntries("org-protected-registry-b", "admin", [
      protectedRegistryInput("B Client"),
    ]);

    expect((await store.listProtectedRegistryEntries("org-protected-registry-a")).map((entry) => entry.value)).toEqual([
      "A Client",
    ]);
    expect((await store.listProtectedRegistryEntries("org-protected-registry-b")).map((entry) => entry.value)).toEqual([
      "B Client",
    ]);

    const [entry] = await store.listProtectedRegistryEntries("org-protected-registry-a");
    await expect(
      store.upsertProtectedRegistryEntry("org-protected-registry-b", "admin", {
        ...protectedRegistryInput("Hijack", { id: entry?.id }),
      }),
    ).rejects.toThrow("protected registry entry not found");
  });
});

describe("threads + messages", () => {
  it("remembers user-selected values per chat without creating a history row", async () => {
    expect(await store.listThreadProtectedValues("preview-owner", "org-preview", "draft-thread")).toEqual([]);
    expect(
      await store.addThreadProtectedValues("preview-owner", "org-preview", "draft-thread", [
        "Project Copper Kite",
        "Project Copper Kite",
        "Northstar account 47",
      ]),
    ).toEqual(["Project Copper Kite", "Northstar account 47"]);

    expect(await store.listThreads("preview-owner", "org-preview")).toEqual([]);
    expect(await store.listThreadProtectedValues("other-user", "org-preview", "draft-thread")).toEqual([]);
    expect(await store.listThreadProtectedValues("preview-owner", "other-org", "draft-thread")).toEqual([]);
    expect(
      await store.removeThreadProtectedValues("preview-owner", "org-preview", "draft-thread", ["Project Copper Kite"]),
    ).toEqual(["Northstar account 47"]);
    expect(
      await store.addThreadProtectedValues("preview-owner", "org-preview", "draft-thread", ["Project Copper Kite"]),
    ).toEqual(["Northstar account 47", "Project Copper Kite"]);

    await store.saveThreadSnapshot("preview-owner", "org-preview", "draft-thread", [
      textMessage("preview-message", "user", "Review Project Copper Kite"),
    ]);
    await store.deleteThread("preview-owner", "org-preview", "draft-thread");
    expect(await store.listThreadProtectedValues("preview-owner", "org-preview", "draft-thread")).toEqual([]);
  });

  it("updates chat protections atomically when the per-chat limit is exceeded", async () => {
    const values = Array.from({ length: 200 }, (_, index) => `protected-${index}`);
    await store.addThreadProtectedValues("limit-owner", "org-limit", "limit-thread", values);
    await expect(
      store.updateThreadProtectedValues("limit-owner", "org-limit", "limit-thread", {
        remove: ["protected-0"],
        add: ["overflow-a", "overflow-b"],
      }),
    ).rejects.toThrow("Protect at most 200 values");
    expect(await store.listThreadProtectedValues("limit-owner", "org-limit", "limit-thread")).toEqual(values);
  });

  it("creates a thread from a snapshot, deriving the title from the first user message", async () => {
    const messages = [
      textMessage("m1", "user", "How do I redact secrets?"),
      textMessage("m2", "assistant", "Like so."),
    ];
    await store.saveThreadSnapshot("owner", ORG, "t1", messages);

    const loaded = await store.getThread("owner", ORG, "t1");
    expect(loaded?.thread.title).toBe("How do I redact secrets?");
    expect(loaded?.thread.traceEnabled).toBe(false);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loaded?.messages[0]?.parts).toEqual([{ type: "text", text: "How do I redact secrets?" }]);
  });

  it("derives attachment thread titles from the user request instead of attachment boilerplate", async () => {
    const messages = [
      textMessage(
        "m-attachment",
        "user",
        [
          "Attached text file 1 (filename omitted for privacy, 2.7 KB):",
          "<file_content>",
          "# PR notes",
          "</file_content>",
          "",
          "User request:",
          "Can you review these release notes?",
        ].join("\n"),
      ),
    ];
    await store.saveThreadSnapshot("owner", ORG, "t-attachment-request", messages);

    const loaded = await store.getThread("owner", ORG, "t-attachment-request");
    expect(loaded?.thread.title).toBe("Can you review these release notes?");
  });

  it("uses a generic title for attachment-only threads", async () => {
    const messages = [
      textMessage(
        "m-attachment-only",
        "user",
        [
          "Please review the attached text file content.",
          "",
          "Attached text file 1 (filename omitted for privacy, 2.7 KB):",
          "<file_content>",
          "# PR notes",
          "</file_content>",
        ].join("\n"),
      ),
    ];
    await store.saveThreadSnapshot("owner", ORG, "t-attachment-only", messages);

    const loaded = await store.getThread("owner", ORG, "t-attachment-only");
    expect(loaded?.thread.title).toBe("Review Attached Text File");
  });

  it("does not title attachment-only threads from user request text inside the file", async () => {
    const messages = [
      textMessage(
        "m-attachment-marker",
        "user",
        [
          "Please review the attached text file content.",
          "",
          "Attached text file 1 (filename omitted for privacy, 2.7 KB):",
          "<file_content>",
          "Meeting notes",
          "",
          "User request:",
          "This line is part of the uploaded file.",
          "</file_content>",
        ].join("\n"),
      ),
    ];
    await store.saveThreadSnapshot("owner", ORG, "t-attachment-marker", messages);

    const loaded = await store.getThread("owner", ORG, "t-attachment-marker");
    expect(loaded?.thread.title).toBe("Review Attached Text File");
  });

  it("snapshot-upsert drops messages no longer present (regenerate) and preserves order", async () => {
    await store.saveThreadSnapshot("owner", ORG, "t2", [
      textMessage("a", "user", "hi"),
      textMessage("b", "assistant", "first answer"),
    ]);
    // Regenerate: the trailing assistant message is replaced with a new id.
    await store.saveThreadSnapshot("owner", ORG, "t2", [
      textMessage("a", "user", "hi"),
      textMessage("c", "assistant", "second answer"),
    ]);

    const loaded = await store.getThread("owner", ORG, "t2");
    expect(loaded?.messages.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("lists threads for a user, most-recently-updated first", async () => {
    await store.saveThreadSnapshot("lister", ORG, "old", [textMessage("x", "user", "old")]);
    await store.saveThreadSnapshot("lister", ORG, "new", [textMessage("y", "user", "new")]);
    const list = await store.listThreads("lister", ORG);
    expect(list[0]?.id).toBe("new");
    expect(list.map((t) => t.id)).toContain("old");
  });

  it("isolates threads by user", async () => {
    await store.saveThreadSnapshot("alice", ORG, "secret", [textMessage("s", "user", "mine")]);
    expect(await store.getThreadOwner("secret")).toEqual({ userId: "alice", orgId: ORG });
    expect(await store.getThread("mallory", ORG, "secret")).toBeNull();
    await expect(
      store.saveThreadSnapshot("mallory", ORG, "secret", [textMessage("s2", "user", "hijack")]),
    ).rejects.toThrow();
  });

  it("isolates a user's threads across workspaces", async () => {
    // Same user, two workspaces: a thread created in one is invisible from the other, and listThreads is
    // partitioned by org.
    await store.saveThreadSnapshot("multi", "org-a", "ta", [textMessage("pa", "user", "in A")]);
    await store.saveThreadSnapshot("multi", "org-b", "tb", [textMessage("pb", "user", "in B")]);

    expect(await store.getThread("multi", "org-b", "ta")).toBeNull();
    expect((await store.listThreads("multi", "org-a")).map((t) => t.id)).toEqual(["ta"]);
    expect((await store.listThreads("multi", "org-b")).map((t) => t.id)).toEqual(["tb"]);

    // A snapshot for the same thread id but the wrong workspace must not hijack it.
    await expect(
      store.saveThreadSnapshot("multi", "org-b", "ta", [textMessage("x", "user", "hijack")]),
    ).rejects.toThrow();
  });

  it("persists per-thread trace capture and isolates it by user/workspace", async () => {
    await store.saveThreadSnapshot("trace-owner", "org-trace", "trace-thread", [textMessage("m", "user", "trace")]);

    expect((await store.getThread("trace-owner", "org-trace", "trace-thread"))?.thread.traceEnabled).toBe(false);
    await store.setThreadTraceEnabled("trace-owner", "org-trace", "trace-thread", true);
    expect((await store.getThread("trace-owner", "org-trace", "trace-thread"))?.thread.traceEnabled).toBe(true);
    expect((await store.listThreads("trace-owner", "org-trace"))[0]?.traceEnabled).toBe(true);

    await expect(store.setThreadTraceEnabled("mallory", "org-trace", "trace-thread", false)).rejects.toThrow();
    await expect(store.setThreadTraceEnabled("trace-owner", "other-org", "trace-thread", false)).rejects.toThrow();
    expect((await store.getThread("trace-owner", "org-trace", "trace-thread"))?.thread.traceEnabled).toBe(true);
  });

  it("can create a new thread with trace capture already enabled", async () => {
    await store.startThread("trace-owner", "org-trace", "first-traced", textMessage("m", "user", "trace"), true);

    expect((await store.getThread("trace-owner", "org-trace", "first-traced"))?.thread.traceEnabled).toBe(true);
  });

  it("renames and deletes", async () => {
    await store.saveThreadSnapshot("owner", ORG, "t3", [textMessage("z", "user", "original")]);
    await store.renameThread("owner", ORG, "t3", "Renamed");
    expect((await store.getThread("owner", ORG, "t3"))?.thread.title).toBe("Renamed");

    await store.deleteThread("owner", ORG, "t3");
    expect(await store.getThread("owner", ORG, "t3")).toBeNull();
  });
});
