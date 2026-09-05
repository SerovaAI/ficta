import { FICTA_EGRESS_EVENT_HEADER, FICTA_SCOPE_HEADER } from "@serovaai/ficta-protocol";
import { gatewayFictaControlClient } from "./ficta-control-client.server";
import { getStorage } from "./storage/storage.server";

/**
 * Fetch the proxy's short-lived, values-free request proof and append it to Gateway's durable
 * thread ledger. The proof is correlated by an unguessable request id and the server-derived scope.
 */
export async function persistThreadEgressEvidence({
  userId,
  orgId,
  threadId,
  fictaScope,
  eventId,
}: {
  userId: string;
  orgId: string;
  threadId: string;
  fictaScope: string;
  eventId: string;
}): Promise<void> {
  const client = await gatewayFictaControlClient({
    requiredCapability: "egress-proof",
    headers: { [FICTA_SCOPE_HEADER]: fictaScope, [FICTA_EGRESS_EVENT_HEADER]: eventId },
  });
  const json = await client.egressProof();
  await (await getStorage()).appendThreadEgressEvent(userId, orgId, threadId, json.proof);
}
