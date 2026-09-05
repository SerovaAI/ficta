import { operatorErrorSchema, egressErrorSchema } from "./extensions.js";
import { ORPCError } from "@orpc/client";
import { protectionPreviewErrorSchema, type FictaProtectionPreviewError } from "./schemas.js";

const previewErrorCodes = {
  forbidden: "FORBIDDEN",
  invalid_request: "INVALID_REQUEST",
  detector_unavailable: "DETECTOR_UNAVAILABLE",
  invariant: "INVARIANT",
} as const;

/** Encode defined preview errors with the stable pre-oRPC HTTP response body. */
export function encodeFictaControlError(error: ORPCError<string, unknown>): unknown {
  const parsed = protectionPreviewErrorSchema.safeParse(error.data);
  if (parsed.success) return parsed.data;
  const operator = operatorErrorSchema.safeParse(error.data);
  if (operator.success) return operator.data;
  const egress = egressErrorSchema.safeParse(error.data);
  if (egress.success) return egress.data;
  if (error.code === "BAD_REQUEST") {
    return {
      ok: false,
      service: "ficta",
      status: "invalid_request",
      message: protectionPreviewValidationMessage(error.data),
    } satisfies FictaProtectionPreviewError;
  }
  return undefined;
}

function protectionPreviewValidationMessage(data: unknown): string {
  if (!data || typeof data !== "object" || !("issues" in data) || !Array.isArray(data.issues)) {
    return "Invalid protection preview request.";
  }
  const issue = data.issues[0];
  if (!issue || typeof issue !== "object") return "Invalid protection preview request.";
  const record = issue as { code?: unknown; message?: unknown; path?: unknown };
  const path = Array.isArray(record.path) ? record.path : [];
  if (path.length === 0) return "Preview body must be an object.";
  if (path[0] === "text") {
    return record.code === "too_big" || record.message === "Preview text is too large."
      ? "Preview text is too large."
      : "Preview text is required.";
  }
  if (path[0] === "protectedValues") {
    if (path.length === 1) {
      if (record.code === "too_big") return "Too many protected values for one chat.";
      if (record.message === "Protected values are too large for one chat.") return record.message;
      return "Protected values must be a list.";
    }
    return record.code === "invalid_type"
      ? "Every protected value must be text."
      : "A protected value is empty or too long.";
  }
  return "Invalid protection preview request.";
}

/** Decode the stable HTTP error body back into the contract's typed oRPC error. */
export function decodeFictaControlError(
  body: unknown,
  response: { status: number },
): ORPCError<string, unknown> | undefined {
  const parsed = protectionPreviewErrorSchema.safeParse(body);
  if (!parsed.success) {
    const operator = operatorErrorSchema.safeParse(body);
    const egress = egressErrorSchema.safeParse(body);
    if (!operator.success && !egress.success) return undefined;
    const code = (
      { 400: "BAD_REQUEST", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 501: "NOT_IMPLEMENTED" } as Record<
        number,
        string
      >
    )[response.status];
    if (!code) return undefined;
    return new ORPCError(code, {
      defined: true,
      status: response.status,
      message: operator.success ? operator.data.message : egress.data!.error.message,
      data: operator.success ? operator.data : egress.data,
    });
  }
  return new ORPCError(previewErrorCodes[parsed.data.status], {
    defined: true,
    status: response.status,
    message: parsed.data.message,
    data: parsed.data,
  });
}

export function fictaControlErrorStatus(error: unknown): number | undefined {
  return error instanceof ORPCError ? error.status : undefined;
}

export function fictaControlErrorData(error: unknown): FictaProtectionPreviewError | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const parsed = protectionPreviewErrorSchema.safeParse(error.data);
  return parsed.success ? parsed.data : undefined;
}

/** Stable operator error body, including config locks and registry validation failures. */
export function fictaOperatorErrorData(error: unknown) {
  if (!(error instanceof ORPCError)) return undefined;
  const parsed = operatorErrorSchema.safeParse(error.data);
  return parsed.success ? parsed.data : undefined;
}
