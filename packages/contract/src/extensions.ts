import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  FICTA_CONFIG_PATH,
  FICTA_EGRESS_PROOF_PATH,
  FICTA_PROTECTION_STATS_PATH,
  FICTA_REGISTRY_RELOAD_PATH,
  FICTA_TRACE_CAPTURE_PATH,
} from "@serovaai/ficta-protocol";
import { protectionHitSchema } from "./schemas.js";

/** Optional interfaces; advertising a capability promises the documented wire behavior. */
export const FICTA_EXTENSION_CAPABILITIES = [
  "protection-stats",
  "egress-proof",
  "config",
  "trace-capture",
  "registry-reload",
  "restore-highlights",
] as const;
export type FictaExtensionCapability = (typeof FICTA_EXTENSION_CAPABILITIES)[number];
const count = z.number().int().nonnegative();
const ok = { ok: z.literal(true), service: z.literal("ficta") };
const restorePolicy = z.enum(["all", "none", "detected"]);
const backend = z.enum(["regex", "presidio", "openmed"]);
const failureMode = z.enum(["fail-open", "fail-closed"]);
const traceState = z.object({ enabled: z.boolean() }).strict();
export const traceCaptureSchema = z.object({ ...ok, traceCapture: traceState }).strict();
export const editableConfigSchema = z
  .object({
    failClosed: z.boolean(),
    piiEnabled: z.boolean(),
    piiBackends: z.array(backend),
    piiFailClosed: z.boolean(),
    piiPresidioUrl: z.string(),
    piiOpenmedUrl: z.string(),
    secretShapesEnabled: z.boolean(),
    surrogateStyle: z.enum(["opaque", "typed"]),
    restoreIntoTools: restorePolicy,
    allowCustomUpstream: z.boolean(),
  })
  .strict();
const editState = z
  .object({
    path: z.string().optional(),
    disabled: z.boolean(),
    restartRequired: z.boolean(),
    values: editableConfigSchema,
    locked: z.partialRecord(editableConfigSchema.keyof(), z.string()),
  })
  .strict();
export const configUpdateSchema = z.object({ ...ok, edit: editState }).strict();
export const configSchema = z
  .object({
    ...ok,
    edit: editState,
    config: z
      .object({
        protection: z
          .object({
            failClosed: z.boolean(),
            requireRegistry: z.boolean(),
            globallyDisabled: z.boolean(),
            redactPaths: z.boolean(),
            restoreIntoTools: restorePolicy,
            surrogateStyle: z.enum(["opaque", "typed"]),
          })
          .strict(),
        detection: z
          .object({
            pii: z
              .object({
                standalone: z.boolean(),
                agents: z.boolean(),
                configuredBackend: z.string(),
                configuredBackends: z.array(z.string()),
                failureMode,
              })
              .strict(),
            secretShapes: z.object({ standalone: z.boolean(), agents: z.boolean() }).strict(),
          })
          .strict(),
        transport: z
          .object({
            host: z.string(),
            port: count,
            upstreams: z.object({ anthropic: z.string(), openai: z.string(), chatgpt: z.string() }).strict(),
            forcedUpstream: z.string().optional(),
            allowCustomUpstream: z.boolean(),
            logLevel: z.enum(["silent", "error", "warn", "info", "debug", "trace"]),
            logBodies: z.boolean(),
            traceAudit: z.boolean(),
            traceCapture: traceState,
            logDir: z.string(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const registryReloadSchema = z
  .object({
    ...ok,
    registry: z
      .object({
        added: count,
        total: count,
        loaded: count.optional(),
        filesRead: count.optional(),
        filesMissing: count.optional(),
        filesErrored: count.optional(),
        revision: z.string().optional(),
        restartRequired: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export const egressProofSchema = z
  .object({
    ...ok,
    proof: z
      .object({
        eventId: z.string(),
        at: z.string(),
        outcome: z.enum(["forwarded", "blocked", "upstream_error"]),
        screening: z.enum(["completed", "detector_unavailable", "not_configured"]),
        model: z.string(),
        redactedValues: count,
        survivingValues: count,
        ambiguousEntityLinks: count,
        labels: z.array(
          protectionHitSchema.extend({ redactedValues: count.optional(), survivingValues: count.optional() }),
        ),
      })
      .strict(),
  })
  .strict();
const bucket = z
  .object({
    name: z.string(),
    requests: count,
    redactedValues: count,
    survivingValues: count,
    blockedRequests: count,
    keptOutOfModelValues: count,
  })
  .strict();
export const protectionStatsSchema = z
  .object({
    ...ok,
    stats: z
      .object({
        version: z.literal(1),
        path: z.string(),
        startedAt: z.string(),
        updatedAt: z.string(),
        totals: z
          .object({
            events: count,
            affectedRequests: count,
            redactedValues: count,
            survivingValues: count,
            blockedRequests: count,
            keptOutOfModelValues: count,
            restoredValues: count,
            withheldFromToolsValues: count,
            residualSurrogateValues: count.optional(),
            ambiguousEntityLinks: count,
            ambiguousEntityLinkRequests: count,
          })
          .strict(),
        byModel: z.array(bucket),
        bySurface: z.array(bucket),
        byWire: z.array(bucket),
        byLabel: z.array(bucket.extend(protectionHitSchema.shape)),
        events: z.array(
          z
            .object({
              index: count,
              at: z.string(),
              requestId: count.optional(),
              method: z.string(),
              path: z.string(),
              wire: z.string(),
              route: z.string().optional(),
              model: z.string(),
              surface: z.enum(["body", "query string", "non-auth headers"]),
              redactedValues: count,
              survivingValues: count,
              blocked: z.boolean(),
              ambiguousEntityLinks: count,
              blockReason: z.literal("detector_unavailable").optional(),
              redactedHits: z.array(protectionHitSchema),
              survivingHits: z.array(protectionHitSchema),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const operatorErrorSchema = z
  .object({
    ok: z.literal(false),
    service: z.literal("ficta"),
    status: z.enum(["forbidden", "invalid_patch", "disabled", "locked", "unsupported", "invalid_registry"]),
    message: z.string(),
    field: editableConfigSchema.keyof().optional(),
  })
  .strict();
export const egressErrorSchema = z
  .object({
    error: z
      .object({
        type: z.enum(["forbidden", "invalid_request", "not_found"]),
        message: z.string(),
      })
      .strict(),
  })
  .strict();
const operatorErrors = {
  BAD_REQUEST: { status: 400, data: operatorErrorSchema },
  FORBIDDEN: { status: 403, data: operatorErrorSchema },
  CONFLICT: { status: 409, data: operatorErrorSchema },
  NOT_IMPLEMENTED: { status: 501, data: operatorErrorSchema },
};

/** These procedures describe existing HTTP handlers; engines may implement only advertised profiles. */
export const fictaExtensionContract = oc.tag("Ficta optional interfaces").router({
  protectionStats: oc
    .route({ method: "GET", path: FICTA_PROTECTION_STATS_PATH, operationId: "getFictaProtectionStats" })
    .input(z.object({ limit: z.number().int().positive().optional() }).optional())
    .output(protectionStatsSchema),
  egressProof: oc
    .route({ method: "GET", path: FICTA_EGRESS_PROOF_PATH, operationId: "getFictaEgressProof" })
    .output(egressProofSchema)
    .errors({
      BAD_REQUEST: { status: 400, data: egressErrorSchema },
      FORBIDDEN: { status: 403, data: egressErrorSchema },
      NOT_FOUND: { status: 404, data: egressErrorSchema },
    }),
  config: oc.route({ method: "GET", path: FICTA_CONFIG_PATH, operationId: "getFictaConfig" }).output(configSchema),
  updateConfig: oc
    .route({ method: "PATCH", path: FICTA_CONFIG_PATH, operationId: "updateFictaConfig" })
    .input(editableConfigSchema.partial())
    .output(configUpdateSchema)
    .errors({
      BAD_REQUEST: operatorErrors.BAD_REQUEST,
      FORBIDDEN: operatorErrors.FORBIDDEN,
      CONFLICT: operatorErrors.CONFLICT,
    }),
  traceCapture: oc
    .route({ method: "GET", path: FICTA_TRACE_CAPTURE_PATH, operationId: "getFictaTraceCapture" })
    .output(traceCaptureSchema)
    .errors({ FORBIDDEN: operatorErrors.FORBIDDEN }),
  updateTraceCapture: oc
    .route({ method: "PATCH", path: FICTA_TRACE_CAPTURE_PATH, operationId: "updateFictaTraceCapture" })
    .input(traceState)
    .output(traceCaptureSchema)
    .errors({ BAD_REQUEST: operatorErrors.BAD_REQUEST, FORBIDDEN: operatorErrors.FORBIDDEN }),
  registryReload: oc
    .route({ method: "POST", path: FICTA_REGISTRY_RELOAD_PATH, operationId: "reloadFictaRegistry" })
    .output(registryReloadSchema)
    .errors({
      FORBIDDEN: operatorErrors.FORBIDDEN,
      CONFLICT: operatorErrors.CONFLICT,
      NOT_IMPLEMENTED: operatorErrors.NOT_IMPLEMENTED,
    }),
});
