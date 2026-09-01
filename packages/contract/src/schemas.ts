import { z } from "zod";

export const FICTA_CAPABILITIES_PATH = "/__ficta/capabilities" as const;
export const FICTA_CONTROL_PROTOCOL_VERSION = 1 as const;
export const FICTA_CONTROL_CAPABILITIES = ["health", "status", "protection-preview"] as const;

export const PROTECTION_PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PROTECTION_PREVIEW_VALUES_MAX = 200;
export const PROTECTION_PREVIEW_VALUE_MAX = 2_000;
export const PROTECTION_PREVIEW_VALUES_MAX_BYTES = 64 * 1024;

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

export const healthSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
  })
  .strict();

export const capabilitiesSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
    protocolVersion: z.literal(FICTA_CONTROL_PROTOCOL_VERSION),
    capabilities: z.array(z.enum(FICTA_CONTROL_CAPABILITIES)),
  })
  .strict();

export const registryProtectionStatusSchema = z
  .object({
    required: z.boolean(),
    status: z.enum(["ready", "empty", "error"]),
    message: z.string(),
  })
  .strict();

export const protectionStatusSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
    protection: z
      .object({
        enabled: z.boolean(),
        protecting: z.boolean(),
        registeredValues: z.number().int().nonnegative(),
        policyExcluded: z.number().int().nonnegative(),
      })
      .strict(),
    registry: registryProtectionStatusSchema.optional(),
    secretShapes: z
      .object({
        enabled: z.boolean(),
        status: z.enum(["off", "ok"]),
        message: z.string(),
      })
      .strict(),
    pii: z
      .object({
        enabled: z.boolean(),
        configuredBackend: z.string(),
        configuredBackends: z.array(z.string()).optional(),
        backend: z.string(),
        status: z.enum(["off", "ok", "degraded", "blocking"]),
        failureMode: z.enum(["fail-open", "fail-closed"]),
        url: z.string().optional(),
        detail: z.string().optional(),
        message: z.string(),
      })
      .strict(),
    activity: z
      .object({
        restoredValues: z.number().int().nonnegative(),
        withheldFromTools: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const protectionHitSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    plugin: z.string().optional(),
    kind: z.enum(["secret", "pii", "custom"]).optional(),
    confidence: z.enum(["exact", "high", "probabilistic"]).optional(),
  })
  .strict();

export const protectionPreviewFindingSchema = protectionHitSchema.extend({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  surrogate: z.string(),
  origin: z.enum(["registry", "detected", "user"]),
});

const protectedValueSchema = z
  .string()
  .min(1)
  .max(PROTECTION_PREVIEW_VALUE_MAX)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0 && value.length <= PROTECTION_PREVIEW_VALUE_MAX, {
    message: "A protected value is empty or too long.",
  });

export const protectionPreviewInputSchema = z
  .object({
    text: z
      .string()
      .max(PROTECTION_PREVIEW_TEXT_MAX_BYTES)
      .refine((value) => utf8Length(value) <= PROTECTION_PREVIEW_TEXT_MAX_BYTES, {
        message: "Preview text is too large.",
      }),
    protectedValues: z.array(protectedValueSchema).max(PROTECTION_PREVIEW_VALUES_MAX).optional(),
  })
  .transform(({ text, protectedValues = [] }, context) => {
    const uniqueValues = [...new Set(protectedValues)];
    const valuesBytes = uniqueValues.reduce((total, value) => total + utf8Length(value), 0);
    if (valuesBytes > PROTECTION_PREVIEW_VALUES_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Protected values are too large for one chat." });
      return z.NEVER;
    }
    return { text, protectedValues: uniqueValues };
  });

export const protectionPreviewSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
    ticket: z.string(),
    textSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    redactedText: z.string(),
    findings: z.array(protectionPreviewFindingSchema),
  })
  .strict();

const protectionPreviewErrorBaseSchema = z
  .object({
    ok: z.literal(false),
    service: z.literal("ficta"),
    message: z.string(),
  })
  .strict();

export const protectionPreviewForbiddenErrorSchema = protectionPreviewErrorBaseSchema.extend({
  status: z.literal("forbidden"),
});
export const protectionPreviewInvalidRequestErrorSchema = protectionPreviewErrorBaseSchema.extend({
  status: z.literal("invalid_request"),
});
export const protectionPreviewDetectorUnavailableErrorSchema = protectionPreviewErrorBaseSchema.extend({
  status: z.literal("detector_unavailable"),
});
export const protectionPreviewInvariantErrorSchema = protectionPreviewErrorBaseSchema.extend({
  status: z.literal("invariant"),
});
export const protectionPreviewErrorSchema = z.discriminatedUnion("status", [
  protectionPreviewForbiddenErrorSchema,
  protectionPreviewInvalidRequestErrorSchema,
  protectionPreviewDetectorUnavailableErrorSchema,
  protectionPreviewInvariantErrorSchema,
]);

export type FictaCapabilities = z.output<typeof capabilitiesSchema>;
export type FictaHealth = z.output<typeof healthSchema>;
export type FictaProtectionStatus = z.output<typeof protectionStatusSchema>;
export type FictaProtectionPreviewInput = z.input<typeof protectionPreviewInputSchema>;
export type FictaProtectionPreview = z.output<typeof protectionPreviewSchema>;
export type FictaProtectionPreviewError = z.output<typeof protectionPreviewErrorSchema>;
