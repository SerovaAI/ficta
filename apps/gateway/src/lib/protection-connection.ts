import type { ConnectConnectionAdapter } from "@tanstack/ai-react";

/** Inject and consume an approval capability at the actual transport boundary. */
export function withOneShotProtectionTicket(
  connection: ConnectConnectionAdapter,
  pending: { current: string | undefined },
): ConnectConnectionAdapter {
  return {
    connect(messages, data, abortSignal, runContext) {
      const protectionTicket = pending.current;
      pending.current = undefined;
      return connection.connect(
        messages,
        protectionTicket ? { ...data, protectionTicket } : data,
        abortSignal,
        runContext,
      );
    },
  };
}
