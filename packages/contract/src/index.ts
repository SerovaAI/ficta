export {
  FICTA_HEALTH_PATH,
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_PROTECTION_TICKET_HEADER,
  FICTA_SCOPE_HEADER,
  FICTA_STATUS_PATH,
} from "@serovaai/ficta-protocol";
export { createFictaControlClient, type CreateFictaControlClientOptions, type FictaControlClient } from "./client.js";
export { fictaControlContract, type FictaControlContract } from "./contract.js";
export {
  decodeFictaControlError,
  encodeFictaControlError,
  fictaControlErrorData,
  fictaControlErrorStatus,
} from "./errors.js";
export {
  capabilitiesSchema,
  FICTA_CAPABILITIES_PATH,
  FICTA_CONTROL_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
  healthSchema,
  PROTECTION_PREVIEW_TEXT_MAX_BYTES,
  PROTECTION_PREVIEW_VALUE_MAX,
  PROTECTION_PREVIEW_VALUES_MAX,
  PROTECTION_PREVIEW_VALUES_MAX_BYTES,
  protectionPreviewDetectorUnavailableErrorSchema,
  protectionPreviewErrorSchema,
  protectionPreviewFindingSchema,
  protectionPreviewForbiddenErrorSchema,
  protectionPreviewInputSchema,
  protectionPreviewInvalidRequestErrorSchema,
  protectionPreviewInvariantErrorSchema,
  protectionPreviewSchema,
  protectionStatusSchema,
  registryProtectionStatusSchema,
  type FictaCapabilities,
  type FictaHealth,
  type FictaProtectionPreview,
  type FictaProtectionPreviewError,
  type FictaProtectionPreviewInput,
  type FictaProtectionStatus,
} from "./schemas.js";
