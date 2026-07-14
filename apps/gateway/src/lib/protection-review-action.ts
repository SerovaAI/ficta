export type ProtectionReviewDestination = "chat" | "chat-and-workspace";
export type WorkspaceSuggestionStatus = "not-requested" | "saved" | "existing" | "failed";

/**
 * Protect first, then optionally suggest. Suggestion failure is deliberately returned as partial success so
 * callers keep the effective chat protection and can offer a workspace retry.
 */
export async function runProtectionReviewAction<T>({
  destination,
  protect,
  suggest,
}: {
  destination: ProtectionReviewDestination;
  protect: () => Promise<T>;
  suggest: () => Promise<{ length: number }>;
}): Promise<{ protection: T; suggestion: WorkspaceSuggestionStatus }> {
  const protection = await protect();
  if (destination === "chat") return { protection, suggestion: "not-requested" };

  try {
    const saved = await suggest();
    return { protection, suggestion: saved.length > 0 ? "saved" : "existing" };
  } catch {
    return { protection, suggestion: "failed" };
  }
}
