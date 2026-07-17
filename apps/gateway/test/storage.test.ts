// Drive the storage seam against an in-memory PGlite through the REAL getStorage()/getDb() path, which
// also exercises the migration applier (migrate.server.ts) on boot. `memory://` makes PGlite ephemeral;
// setting it before any import that touches the DB is what routes create() to an in-memory instance.
process.env.FICTA_GATEWAY_DATA_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Storage } from "@/lib/storage/storage.server";
import { getStorage } from "@/lib/storage/storage.server";
import type {
  EncryptedProviderKey,
  ProtectedRegistryEntryInput,
  ProtectionStatsSnapshot,
  ProtectionStatsTotals,
  StoredMessage,
  ThreadModelSettings,
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
const miniSettings: ThreadModelSettings = {
  provider: "openai",
  model: "gpt-5-mini",
  reasoningEffort: "medium",
};
const solSettings: ThreadModelSettings = {
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
};

describe("instance settings", () => {
  it("is one row per workspace that merges patches", async () => {
    expect(await store.getInstanceSettings(ORG)).toEqual({});
    await store.patchInstanceSettings(ORG, { instanceName: "Acme" });
    await store.patchInstanceSettings(ORG, { allowedModels: ["openai/gpt-5"] });
    await store.patchInstanceSettings(ORG, { suggestedPrompts: ["Summarize this."] });
    await store.patchInstanceSettings(ORG, { protectionReviewMinimum: "adaptive" });
    expect(await store.getInstanceSettings(ORG)).toEqual({
      instanceName: "Acme",
      allowedModels: ["openai/gpt-5"],
      suggestedPrompts: ["Summarize this."],
      protectionReviewMinimum: "adaptive",
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
  ambiguousEntityLinks: 0,
  ambiguousEntityLinkRequests: 0,
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
        ambiguousEntityLinks: 2,
        ambiguousEntityLinkRequests: 1,
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
        ambiguousEntityLinks: 5,
        ambiguousEntityLinkRequests: 2,
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
      ambiguousEntityLinks: 5,
      ambiguousEntityLinkRequests: 2,
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
  protectionKind: "literal",
  value,
  forms: [],
  status: "approved",
  source: "manual",
  ...patch,
});

describe("confidential protected registry", () => {
  it("imports, updates, and deletes workspace protected registry entries", async () => {
    const imported = await store.importProtectedRegistryEntries("org-protected-registry", "admin-1", [
      protectedRegistryInput("Northstar Biologics (Pty) Ltd", {
        forms: [
          { value: "Northstar", kind: "alias", boundary: "substring" },
          { value: "NBL", kind: "alias", boundary: "substring" },
        ],
        source: "csv",
      }),
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
      protectionKind: "literal",
      value: "Northstar Biologics (Pty) Ltd",
      forms: [
        { value: "Northstar", kind: "alias", boundary: "substring" },
        { value: "NBL", kind: "alias", boundary: "substring" },
      ],
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
        forms: [{ value: "Proxima", kind: "alias", boundary: "substring" }],
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
    await store.saveThreadSnapshot("owner", ORG, "t1", messages, miniSettings);

    const loaded = await store.getThread("owner", ORG, "t1");
    expect(loaded?.thread.title).toBe("How do I redact secrets?");
    expect(loaded?.thread.modelSettings).toEqual(miniSettings);
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
    expect(await store.getThreadOwner("secret")).toEqual({ userId: "alice", orgId: ORG, deleted: false });
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

  it("updates model settings without reordering the thread and enforces ownership", async () => {
    await store.startThread(
      "model-owner",
      "org-model",
      "model-thread",
      textMessage("m", "user", "model"),
      false,
      miniSettings,
    );
    const updatedAt = (await store.getThread("model-owner", "org-model", "model-thread"))?.thread.updatedAt;

    await store.setThreadModelSettings("model-owner", "org-model", "model-thread", solSettings);

    const updated = await store.getThread("model-owner", "org-model", "model-thread");
    expect(updated?.thread.modelSettings).toEqual(solSettings);
    expect(updated?.thread.updatedAt).toBe(updatedAt);

    // A response finishing after the picker save may carry the older controls captured at send time.
    await store.saveThreadSnapshot(
      "model-owner",
      "org-model",
      "model-thread",
      [textMessage("m", "user", "model")],
      miniSettings,
    );
    expect((await store.getThread("model-owner", "org-model", "model-thread"))?.thread.modelSettings).toEqual(
      solSettings,
    );

    // The initial start request is also fire-and-forget and may arrive after the picker mutation.
    await store.startThread(
      "model-owner",
      "org-model",
      "model-thread",
      textMessage("m", "user", "model"),
      false,
      miniSettings,
    );
    expect((await store.getThread("model-owner", "org-model", "model-thread"))?.thread.modelSettings).toEqual(
      solSettings,
    );

    await expect(store.setThreadModelSettings("mallory", "org-model", "model-thread", miniSettings)).rejects.toThrow(
      "thread not found",
    );
    await expect(
      store.setThreadModelSettings("model-owner", "other-org", "model-thread", miniSettings),
    ).rejects.toThrow("thread not found");
  });

  it("loads legacy threads without model settings", async () => {
    await store.saveThreadSnapshot("legacy-owner", "org-legacy", "legacy-thread", [textMessage("m", "user", "legacy")]);

    expect((await store.getThread("legacy-owner", "org-legacy", "legacy-thread"))?.thread.modelSettings).toBe(
      undefined,
    );
  });

  it("can create a new thread with trace capture already enabled", async () => {
    await store.startThread("trace-owner", "org-trace", "first-traced", textMessage("m", "user", "trace"), true);

    expect((await store.getThread("trace-owner", "org-trace", "first-traced"))?.thread.traceEnabled).toBe(true);
  });

  it("renames and deletes", async () => {
    await store.saveThreadSnapshot("owner", ORG, "t3", [textMessage("z", "user", "original")]);
    await store.addThreadProtectedValues("owner", ORG, "t3", ["Hard Delete Client"]);
    await store.renameThread("owner", ORG, "t3", "Renamed");
    expect((await store.getThread("owner", ORG, "t3"))?.thread.title).toBe("Renamed");

    await store.deleteThread("owner", ORG, "t3");
    expect(await store.getThread("owner", ORG, "t3")).toBeNull();
    expect(await store.getThreadOwner("t3")).toBeNull();
    expect(await store.listThreadProtectedValues("owner", ORG, "t3")).toEqual([]);
  });
});

describe("deleted-thread recovery", () => {
  it("records values-free policy changes when an administrator actor is supplied", async () => {
    const orgId = "org-retention-policy-audit";
    await store.patchInstanceSettings(
      orgId,
      { deletedThreadRecoveryDays: 7, recordsAuditRetentionDays: 90 },
      "admin-user",
    );
    expect(await store.listRecordsAuditEvents(orgId)).toEqual([
      expect.objectContaining({ action: "policy_changed", actorUserId: "admin-user" }),
    ]);
    const [event] = await store.listRecordsAuditEvents(orgId);
    expect(Object.keys(event ?? {})).not.toEqual(
      expect.arrayContaining(["deletedThreadRecoveryDays", "recordsAuditRetentionDays"]),
    );
  });

  it("soft-deletes, seals normal access, audits records access, and restores the same thread", async () => {
    const orgId = "org-recovery";
    const userId = "recovery-owner";
    await store.patchInstanceSettings(orgId, {
      deletedThreadRecoveryDays: 30,
      recordsAuditRetentionDays: 365,
    });
    const attachmentPart = {
      type: "file",
      mediaType: "text/plain",
      filename: "brief.txt",
      url: "data:text/plain;base64,cHJpdmlsZWdlZCBhdHRhY2htZW50",
    };
    const userMessage = textMessage("recovery-user", "user", "privileged transcript");
    userMessage.parts.push(attachmentPart);
    await store.saveThreadSnapshot(userId, orgId, "recoverable", [
      userMessage,
      textMessage("recovery-assistant", "assistant", "privileged response"),
    ]);
    await store.addThreadProtectedValues(userId, orgId, "recoverable", ["Client Example"]);

    await store.deleteThread(userId, orgId, "recoverable");
    expect(await store.getThread(userId, orgId, "recoverable")).toBeNull();
    expect(await store.listThreads(userId, orgId)).toEqual([]);
    await expect(
      store.saveThreadSnapshot(userId, orgId, "recoverable", [textMessage("late", "user", "late write")]),
    ).rejects.toThrow("thread not found");
    await expect(store.listThreadProtectedValues(userId, orgId, "recoverable")).rejects.toThrow("thread not found");
    await expect(store.getThreadEgressReceipt(userId, orgId, "recoverable")).rejects.toThrow("thread not found");

    const retained = await store.listRetainedThreads(orgId);
    // Exact shape, not objectContaining: the records list is a privacy boundary, so an accidental new
    // field (title, message content, protected values) must fail this test.
    expect(retained).toEqual([
      {
        threadId: "recoverable",
        ownerUserId: userId,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        deletedAt: expect.any(String),
        purgeAfter: expect.any(String),
        messageCount: 2,
      },
    ]);
    expect(new Date(retained[0]?.purgeAfter ?? 0).getTime() - new Date(retained[0]?.deletedAt ?? 0).getTime()).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
    expect(JSON.stringify(retained)).not.toContain("privileged transcript");

    const detail = await store.getRetainedThread(orgId, "records-user", "recoverable", { reference: "REC-1042" });
    expect(detail?.thread.id).toBe("recoverable");
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[0]?.parts).toContainEqual(attachmentPart);
    expect(await store.listRecordsAuditEvents(orgId, "recoverable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "deleted", actorUserId: userId }),
        expect.objectContaining({ action: "viewed", actorUserId: "records-user", reference: "REC-1042" }),
      ]),
    );

    await store.restoreRetainedThread(orgId, "records-user", "recoverable", { reference: "REC-1043" });
    const restored = await store.getThread(userId, orgId, "recoverable");
    expect(restored?.messages).toHaveLength(2);
    expect(restored?.messages[0]?.parts).toContainEqual(attachmentPart);
    expect(await store.listThreadProtectedValues(userId, orgId, "recoverable")).toEqual(["Client Example"]);
    expect(await store.listRetainedThreads(orgId)).toEqual([]);
    expect(await store.listRecordsAuditEvents(orgId, "recoverable")).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "restored", actorUserId: "records-user" })]),
    );
  });

  it("keeps policy changes prospective and isolates the records list by organization", async () => {
    const orgId = "org-prospective";
    await store.patchInstanceSettings(orgId, {
      deletedThreadRecoveryDays: 10,
      recordsAuditRetentionDays: 20,
    });
    await store.saveThreadSnapshot("owner", orgId, "prospective", [textMessage("p1", "user", "policy")]);
    await store.deleteThread("owner", orgId, "prospective");
    const originalPurgeAfter = (await store.listRetainedThreads(orgId))[0]?.purgeAfter;

    await store.patchInstanceSettings(orgId, { deletedThreadRecoveryDays: 1 });
    expect((await store.listRetainedThreads(orgId))[0]?.purgeAfter).toBe(originalPurgeAfter);
    expect(await store.listRetainedThreads("other-org")).toEqual([]);

    await store.restoreRetainedThread(orgId, "records", "prospective", {});
    await store.deleteThread("owner", orgId, "prospective");
    const nextPurgeAfter = (await store.listRetainedThreads(orgId))[0]?.purgeAfter;
    expect(new Date(nextPurgeAfter ?? 0).getTime()).toBeLessThan(new Date(originalPurgeAfter ?? 0).getTime());
    const lifecycle = await store.listRecordsAuditEvents(orgId, "prospective");
    expect(lifecycle.filter((event) => event.action === "deleted")).toHaveLength(2);
    expect(lifecycle.filter((event) => event.action === "restored")).toHaveLength(1);
  });

  it("seals records access when the recovery window lapses, even before the sweep runs", async () => {
    const orgId = "org-lapsed-access";
    await store.patchInstanceSettings(orgId, { deletedThreadRecoveryDays: 1, recordsAuditRetentionDays: 30 });
    await store.saveThreadSnapshot("owner", orgId, "lapsed", [textMessage("l1", "user", "lapsed")]);
    await store.deleteThread("owner", orgId, "lapsed");
    expect(await store.listRetainedThreads(orgId)).toHaveLength(1);

    vi.useFakeTimers({ now: Date.now() + 2 * 24 * 60 * 60 * 1_000, toFake: ["Date"] });
    try {
      expect(await store.listRetainedThreads(orgId)).toEqual([]);
      expect(await store.getRetainedThread(orgId, "records", "lapsed", {})).toBeNull();
      await expect(store.restoreRetainedThread(orgId, "records", "lapsed", {})).rejects.toThrow(
        "retained thread not found",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("purges due content idempotently while preserving the new purge event", async () => {
    const orgId = "org-retention-sweep";
    const userId = "sweep-owner";
    await store.patchInstanceSettings(orgId, {
      deletedThreadRecoveryDays: 1,
      recordsAuditRetentionDays: 30,
    });
    await store.saveThreadSnapshot(userId, orgId, "due-thread", [textMessage("due", "user", "due")]);
    await store.addThreadProtectedValues(userId, orgId, "due-thread", ["Due Client"]);
    await store.deleteThread(userId, orgId, "due-thread");
    await store.patchInstanceSettings(orgId, { deletedThreadRecoveryDays: 3 });
    await store.saveThreadSnapshot(userId, orgId, "not-due-thread", [textMessage("not-due", "user", "not due")]);
    await store.deleteThread(userId, orgId, "not-due-thread");

    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    const concurrent = await Promise.all([store.runRetentionSweep(future, 1), store.runRetentionSweep(future, 1)]);
    const concurrentCounts = concurrent.map((run) => run.find((result) => result.orgId === orgId)?.purgedThreads ?? 0);
    expect(concurrentCounts.reduce((total, count) => total + count, 0)).toBe(1);
    const repeated = (await store.runRetentionSweep(future, 1)).find((result) => result.orgId === orgId);
    expect(repeated?.purgedThreads).toBe(0);
    expect(await store.listRetainedThreads(orgId)).toEqual([
      expect.objectContaining({ threadId: "not-due-thread", ownerUserId: userId }),
    ]);
    expect(await store.getThreadOwner("due-thread")).toBeNull();
    expect(await store.getThreadOwner("not-due-thread")).toEqual({ userId, orgId, deleted: true });
    expect(await store.listThreadProtectedValues(userId, orgId, "due-thread")).toEqual([]);
    expect(await store.listRecordsAuditEvents(orgId, "due-thread")).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "purged", actorUserId: "system:retention" })]),
    );
  });

  it("still purges an existing retained chat if recovery and audit settings are later absent", async () => {
    const orgId = "org-disabled-retention-sweep";
    await store.patchInstanceSettings(orgId, {
      deletedThreadRecoveryDays: 1,
      recordsAuditRetentionDays: 30,
    });
    await store.saveThreadSnapshot("owner", orgId, "disabled-policy-thread", [
      textMessage("disabled", "user", "retained before disable"),
    ]);
    await store.deleteThread("owner", orgId, "disabled-policy-thread");
    await store.patchInstanceSettings(orgId, {
      deletedThreadRecoveryDays: undefined,
      recordsAuditRetentionDays: undefined,
    });
    expect(await store.listRetainedThreads(orgId)).toEqual([
      expect.objectContaining({ threadId: "disabled-policy-thread" }),
    ]);

    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    const result = (await store.runRetentionSweep(future)).find((item) => item.orgId === orgId);
    expect(result?.purgedThreads).toBe(1);
    expect(await store.getThreadOwner("disabled-policy-thread")).toBeNull();
  });

  it("expires lifecycle and egress evidence on the configured audit schedule", async () => {
    const orgId = "org-audit-expiry";
    const occurredAt = new Date();
    await store.patchInstanceSettings(orgId, { recordsAuditRetentionDays: 1 }, "records");
    expect(await store.listRecordsAuditEvents(orgId)).toEqual([expect.objectContaining({ action: "policy_changed" })]);
    await store.saveThreadSnapshot("owner", orgId, "expired-evidence", [textMessage("evidence", "user", "audit")]);
    await store.appendThreadEgressEvent("owner", orgId, "expired-evidence", {
      eventId: "expired-egress-event",
      at: occurredAt.toISOString(),
      outcome: "forwarded",
      screening: "completed",
      model: "test-model",
      redactedValues: 1,
      survivingValues: 0,
      ambiguousEntityLinks: 0,
      labels: [],
    });

    const result = (await store.runRetentionSweep(new Date(occurredAt.getTime() + 2 * 24 * 60 * 60 * 1_000))).find(
      (item) => item.orgId === orgId,
    );
    expect(result).toEqual(expect.objectContaining({ purgedAuditEvents: 1, purgedEgressEvents: 1 }));
    expect(await store.listRecordsAuditEvents(orgId)).toEqual([]);
    expect((await store.getThreadEgressReceipt("owner", orgId, "expired-evidence")).events).toEqual([]);
  });
});
