import { createServerFn } from "@tanstack/react-start";
import { requireRecordsScope } from "@/lib/auth/guards.server";
import { RECORDS_PERMISSIONS } from "@/lib/auth/types";
import { validateThreadReason } from "./records-validation";
import { getStorage } from "./storage.server";
import type { RetainedThreadDetail, RetainedThreadSummary } from "./types";

export const fetchRetainedThreads = createServerFn({ method: "GET" }).handler(
  async (): Promise<RetainedThreadSummary[]> => {
    const { orgId } = await requireRecordsScope(RECORDS_PERMISSIONS.list);
    return (await getStorage()).listRetainedThreads(orgId);
  },
);

export const fetchRetainedThread = createServerFn({ method: "POST" })
  .validator(validateThreadReason)
  .handler(async ({ data }): Promise<RetainedThreadDetail | null> => {
    const { orgId, actorUserId } = await requireRecordsScope(RECORDS_PERMISSIONS.read);
    return (await getStorage()).getRetainedThread(orgId, actorUserId, data.threadId, data.reason);
  });

export const restoreRetainedThread = createServerFn({ method: "POST" })
  .validator(validateThreadReason)
  .handler(async ({ data }): Promise<void> => {
    const { orgId, actorUserId } = await requireRecordsScope(RECORDS_PERMISSIONS.restore);
    await (await getStorage()).restoreRetainedThread(orgId, actorUserId, data.threadId, data.reason);
  });
