import {
  FICTA_EGRESS_EVENT_HEADER,
  FICTA_EGRESS_PROOF_PATH,
  FICTA_SCOPE_HEADER,
  isEgressProofOk,
} from "@serovaai/ficta-protocol";
import { proxyBaseUrl } from "./proxy-base.server";
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
  const response = await fetch(`${proxyBaseUrl()}${FICTA_EGRESS_PROOF_PATH}`, {
    headers: {
      accept: "application/json",
      [FICTA_SCOPE_HEADER]: fictaScope,
      [FICTA_EGRESS_EVENT_HEADER]: eventId,
    },
  });
  const json = (await response.json()) as unknown;
  if (!response.ok || !isEgressProofOk(json)) {
    throw new Error("the proxy did not return a valid egress proof");
  }
  await (await getStorage()).appendThreadEgressEvent(userId, orgId, threadId, json.proof);
}
