import { createHash } from "node:crypto";

/**
 * Stable, authenticated proxy isolation key. Hashing a length-preserving JSON tuple avoids delimiter
 * ambiguity and keeps tenant/user identifiers out of the internal header while ensuring that two
 * users who know the same thread id can never address the same detector vault or ticket namespace.
 */
export function fictaScopeFor(orgId: string, userId: string, threadId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([orgId, userId, threadId]))
    .digest("hex");
  return `v1:${digest}`;
}
