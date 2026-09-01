import {
  FICTA_CONTROL_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
  fictaControlContract,
  type FictaProtectionPreview,
  type FictaProtectionPreviewError,
  type FictaProtectionStatus,
} from "@serovaai/ficta-contract";
import { implement } from "@orpc/server";

export interface FictaControlContext {
  remoteAddress?: string;
  scopeKey?: string;
}

export interface FictaControlService {
  status: () => Promise<FictaProtectionStatus>;
  protectionPreview: (
    input: { text: string; protectedValues: string[] },
    context: FictaControlContext,
  ) => Promise<FictaProtectionPreview | FictaProtectionPreviewError>;
}

export function createFictaControlRouter(service: FictaControlService) {
  const os = implement(fictaControlContract).$context<FictaControlContext>();

  return os.router({
    capabilities: os.capabilities.handler(() => ({
      ok: true,
      service: "ficta",
      protocolVersion: FICTA_CONTROL_PROTOCOL_VERSION,
      capabilities: [...FICTA_CONTROL_CAPABILITIES],
    })),
    health: os.health.handler(() => ({ ok: true, service: "ficta" })),
    status: os.status.handler(() => service.status()),
    protectionPreview: os.protectionPreview.handler(async ({ input, context, errors }) => {
      const result = await service.protectionPreview(input, context);
      if (result.ok) return result;

      switch (result.status) {
        case "forbidden":
          throw errors.FORBIDDEN({ message: result.message, data: result });
        case "invalid_request":
          throw errors.INVALID_REQUEST({ message: result.message, data: result });
        case "detector_unavailable":
          throw errors.DETECTOR_UNAVAILABLE({ message: result.message, data: result });
        case "invariant":
          throw errors.INVARIANT({ message: result.message, data: result });
      }
    }),
  });
}
