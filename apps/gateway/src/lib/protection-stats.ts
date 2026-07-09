import { isProtectionStatsOk, type ProtectionStats, type ProtectionStatsLabelBucket } from "@serovaai/ficta-protocol";
import { createServerFn } from "@tanstack/react-start";
import type { ProtectionStatsDailySummary } from "@/lib/storage/types";

export type { ProtectionStats, ProtectionStatsDailySummary, ProtectionStatsLabelBucket };
export { isProtectionStatsOk };

/**
 * Admin-only, server-only read of values-free redaction proof for the current proxy run. The proxy
 * endpoint intentionally returns counts and labels only; never protected literals or transcript text.
 */
export const fetchProtectionStats = createServerFn({ method: "GET" }).handler(async (): Promise<ProtectionStats> => {
  const [{ requireAdminScope }, { readCurrentProtectionStats }] = await Promise.all([
    import("@/lib/auth/guards.server"),
    import("@/lib/protection-stats.server"),
  ]);
  const { orgId } = await requireAdminScope();
  return readCurrentProtectionStats(orgId);
});

export const fetchProtectionStatsHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProtectionStatsDailySummary[]> => {
    const [{ requireAdminScope }, { listProtectionStatsHistory }] = await Promise.all([
      import("@/lib/auth/guards.server"),
      import("@/lib/protection-stats.server"),
    ]);
    const { orgId } = await requireAdminScope();
    return listProtectionStatsHistory(orgId);
  },
);
