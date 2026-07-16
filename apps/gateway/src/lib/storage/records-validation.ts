import type { RecordsAccessReason } from "./types";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) throw new Error("invalid records request");
  return input as Record<string, unknown>;
}

export function validateThreadReason(input: unknown): { threadId: string; reason: RecordsAccessReason } {
  const value = asObject(input);
  if (typeof value.threadId !== "string" || !value.threadId.trim()) throw new Error("invalid threadId");
  const reasonValue = asObject(value.reason);
  const reference = typeof reasonValue.reference === "string" ? reasonValue.reference.trim() : "";
  if (reference && !REFERENCE.test(reference)) {
    throw new Error("Reference may contain only letters, numbers, period, underscore, colon, slash, and hyphen.");
  }
  return {
    threadId: value.threadId.trim(),
    reason: reference ? { reference } : {},
  };
}

export function restoreConfirmationMessage(ownerUserId: string): string {
  return `Restore this chat to its original owner (${ownerUserId})? The restore will be recorded separately.`;
}
