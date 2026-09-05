import { z } from "zod";

export const FICTA_CAPABILITIES_PATH = "/__ficta/capabilities" as const;
export const FICTA_CONTROL_PROTOCOL_VERSION = 1 as const;
export const FICTA_CONTROL_CAPABILITIES = ["health", "status", "protection-preview"] as const;
export const FICTA_SCOPE_MAX_LENGTH = 256;

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
    protocolVersion: z
      .literal(FICTA_CONTROL_PROTOCOL_VERSION)
      .describe("Breaking wire-contract version implemented by this control plane."),
    capabilities: z
      .array(z.string().min(1))
      .describe("Supported optional procedures. Clients must ignore capability names they do not recognize."),
  })
  .strict();

export const registryProtectionStatusSchema = z
  .object({
    required: z.boolean().describe("Whether provider requests are blocked until the registry is ready."),
    status: z.enum(["ready", "empty", "error"]).describe("Current exact-match registry readiness."),
    message: z.string().describe("Values-free operator guidance for the current registry state."),
  })
  .strict();

export const protectionStatusSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
    protection: z
      .object({
        enabled: z.boolean().describe("Whether the engine has registered values or detector plugins available."),
        protecting: z.boolean().describe("Whether registered values or an active detector are currently configured."),
        registeredValues: z.number().int().nonnegative().describe("Count of loaded exact-match protected values."),
        policyExcluded: z
          .number()
          .int()
          .nonnegative()
          .describe("Count of discovered registry values excluded by configured policy."),
      })
      .strict(),
    registry: registryProtectionStatusSchema.optional(),
    secretShapes: z
      .object({
        enabled: z.boolean().describe("Whether request-time secret-shape detection is enabled."),
        status: z.enum(["off", "ok"]).describe("Secret-shape detector posture."),
        message: z.string().describe("Values-free explanation of the secret-shape posture."),
      })
      .strict(),
    pii: z
      .object({
        enabled: z.boolean().describe("Whether request-time PII detection is enabled."),
        configuredBackend: z.string().describe("Compatibility string naming the configured PII backend set."),
        configuredBackends: z.array(z.string()).optional().describe("Configured PII backend names."),
        backend: z.string().describe("Active PII backend names as a compatibility string."),
        status: z.enum(["off", "ok", "degraded", "blocking"]).describe("Current PII detector posture."),
        failureMode: z
          .enum(["fail-open", "fail-closed"])
          .describe("Whether a required PII backend outage skips that backend or blocks provider traffic."),
        url: z.string().optional().describe("Values-free health URL for a single configured network backend."),
        detail: z.string().optional().describe("Values-free backend health diagnostic."),
        message: z.string().describe("Values-free explanation of the current PII posture."),
      })
      .strict(),
    activity: z
      .object({
        restoredValues: z
          .number()
          .int()
          .nonnegative()
          .describe("Cumulative protected values restored during this proxy run."),
        withheldFromTools: z
          .number()
          .int()
          .nonnegative()
          .describe("Cumulative protected values withheld from tool-call arguments during this proxy run."),
      })
      .strict()
      .optional(),
  })
  .strict();

export const protectionHitSchema = z
  .object({
    name: z.string().describe("Values-free detector or registry label for the finding."),
    source: z.string().describe("Values-free source category for the finding."),
    plugin: z.string().optional().describe("Plugin that produced the finding, when available."),
    kind: z.enum(["secret", "pii", "custom"]).optional().describe("Coarse protected-value category."),
    confidence: z
      .enum(["exact", "high", "probabilistic"])
      .optional()
      .describe("Confidence class assigned by the protection source."),
  })
  .strict();

export const protectionPreviewFindingSchema = protectionHitSchema
  .extend({
    start: z.number().int().nonnegative().describe("Inclusive UTF-16 offset into the exact preview text."),
    end: z
      .number()
      .int()
      .nonnegative()
      .describe("Exclusive UTF-16 offset into the exact preview text; must be greater than start."),
    surrogate: z.string().describe("Opaque replacement rendered in redactedText."),
    origin: z.enum(["registry", "detected", "user"]).describe("How this protected value entered the preview."),
  })
  .refine((finding) => finding.end > finding.start, { message: "Finding end must follow start.", path: ["end"] });

const protectedValueSchema = z
  .string()
  .min(1)
  .max(PROTECTION_PREVIEW_VALUE_MAX)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0 && value.length <= PROTECTION_PREVIEW_VALUE_MAX, {
    message: "A protected value is empty or too long.",
  });

export const protectionPreviewTextSchema = z
  .string()
  .max(PROTECTION_PREVIEW_TEXT_MAX_BYTES)
  .refine((value) => utf8Length(value) <= PROTECTION_PREVIEW_TEXT_MAX_BYTES, {
    message: "Preview text is too large.",
  });

export const protectionPreviewProtectedValuesSchema = z
  .array(protectedValueSchema)
  .max(PROTECTION_PREVIEW_VALUES_MAX)
  .optional();

export const protectionPreviewInputSchema = z
  .object({
    text: protectionPreviewTextSchema,
    protectedValues: protectionPreviewProtectedValuesSchema,
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

/** Opaque transport-safe value: no token encoding or engine-specific format is implied. */
export const protectionTicketSchema = z
  .string()
  .min(1)
  .regex(/^[\x21-\x7e]+$/u);

export const protectionPreviewSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("ficta"),
    ticket: protectionTicketSchema.describe(
      "Opaque, short-lived, single-use authorization for the reviewed provider send.",
    ),
    textSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .describe("Lowercase SHA-256 of the exact preview text bound to the ticket."),
    redactedText: z.string().describe("Preview text with all planned protections applied."),
    findings: z.array(protectionPreviewFindingSchema).describe("Ordered protected occurrences in the preview text."),
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
