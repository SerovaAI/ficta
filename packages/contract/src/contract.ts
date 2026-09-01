import { FICTA_HEALTH_PATH, FICTA_PROTECTION_PREVIEW_PATH, FICTA_STATUS_PATH } from "@serovaai/ficta-protocol";
import { oc } from "@orpc/contract";
import {
  capabilitiesSchema,
  FICTA_CAPABILITIES_PATH,
  healthSchema,
  protectionPreviewDetectorUnavailableErrorSchema,
  protectionPreviewForbiddenErrorSchema,
  protectionPreviewInputSchema,
  protectionPreviewInvalidRequestErrorSchema,
  protectionPreviewInvariantErrorSchema,
  protectionPreviewSchema,
  protectionStatusSchema,
} from "./schemas.js";

const controlProcedure = oc;

export const fictaControlContract = oc.tag("Ficta control plane").router({
  capabilities: controlProcedure
    .route({
      method: "GET",
      path: FICTA_CAPABILITIES_PATH,
      operationId: "getFictaCapabilities",
      summary: "Discover the Ficta control-plane version and supported procedures",
    })
    .output(capabilitiesSchema),
  health: controlProcedure
    .route({
      method: "GET",
      path: FICTA_HEALTH_PATH,
      operationId: "getFictaHealth",
      summary: "Check whether the Ficta proxy process is serving requests",
    })
    .output(healthSchema),
  status: controlProcedure
    .route({
      method: "GET",
      path: FICTA_STATUS_PATH,
      operationId: "getFictaProtectionStatus",
      summary: "Read values-free protection readiness and activity metadata",
    })
    .output(protectionStatusSchema),
  protectionPreview: controlProcedure
    .route({
      method: "POST",
      path: FICTA_PROTECTION_PREVIEW_PATH,
      operationId: "createFictaProtectionPreview",
      summary: "Preview protection and issue a short-lived send ticket",
    })
    .input(protectionPreviewInputSchema)
    .output(protectionPreviewSchema)
    .errors({
      FORBIDDEN: { status: 403, data: protectionPreviewForbiddenErrorSchema },
      INVALID_REQUEST: { status: 400, data: protectionPreviewInvalidRequestErrorSchema },
      DETECTOR_UNAVAILABLE: { status: 503, data: protectionPreviewDetectorUnavailableErrorSchema },
      INVARIANT: { status: 422, data: protectionPreviewInvariantErrorSchema },
    }),
});

export type FictaControlContract = typeof fictaControlContract;
