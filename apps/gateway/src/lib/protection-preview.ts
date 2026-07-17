import { isProtectionPreviewOk, type ProtectionPreviewFinding } from "@serovaai/ficta-protocol";

export interface GatewayProtectionPreview {
  ticket: string;
  textSha256: string;
  redactedText: string;
  findings: ProtectionPreviewFinding[];
  protectedValues: string[];
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
  if (!isProtectionPreviewOk(json) || !hasProtectedValues(json)) {
    throw new Error("The protection preview response was not understood.");
  }
  return {
    ticket: json.ticket,
    textSha256: json.textSha256,
    redactedText: json.redactedText,
    findings: json.findings,
    protectedValues: json.protectedValues,
  };
}

function hasProtectedValues(value: unknown): value is { protectedValues: string[] } {
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
