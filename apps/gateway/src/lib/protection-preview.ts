import { protectionPreviewSchema } from "@serovaai/ficta-contract";
import { type ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { isSecondOpinion, type SecondOpinion } from "./second-opinion";

export interface GatewayProtectionPreview {
  ticket: string;
  textSha256: string;
  redactedText: string;
  findings: ProtectionPreviewFinding[];
  protectedValues: string[];
  /** Advisory only; present when the operator enabled the second-opinion service. */
  secondOpinion?: SecondOpinion;
}

export async function previewProtection(input: {
  threadId: string;
  text: string;
  addValues?: string[];
  removeValues?: string[];
  signal?: AbortSignal;
}): Promise<GatewayProtectionPreview> {
  const { signal, ...body } = input;
  const response = await fetch("/api/protection-preview", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await response.json()) as unknown;
  if (!response.ok) throw new Error(readMessage(json) ?? `Protection preview failed (HTTP ${response.status}).`);
  if (!hasProtectedValues(json)) {
    throw new Error("The protection preview response was not understood.");
  }
  // Gateway-only fields are stripped before the strict contract parse and re-attached after it.
  const { protectedValues: _values, secondOpinion, ...preview } = json;
  const parsed = protectionPreviewSchema.parse(preview);
  return {
    ...parsed,
    protectedValues: json.protectedValues,
    ...(isSecondOpinion(secondOpinion) ? { secondOpinion } : {}),
  };
}

function hasProtectedValues(value: unknown): value is Record<string, unknown> & { protectedValues: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).protectedValues) &&
    ((value as Record<string, unknown>).protectedValues as unknown[]).every((entry) => typeof entry === "string")
  );
}

function readMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
