import type { ConnectConnectionAdapter } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { withOneShotProtectionTicket } from "@/lib/protection-connection";

describe("withOneShotProtectionTicket", () => {
  it("attaches a ticket to exactly one transport request", () => {
    const sent: Array<Record<string, unknown> | undefined> = [];
    const connection: ConnectConnectionAdapter = {
      connect(_messages, data) {
        sent.push(data);
        return (async function* empty() {})();
      },
    };
    const pending = { current: "ticket-once" as string | undefined };
    const wrapped = withOneShotProtectionTicket(connection, pending);

    wrapped.connect([], { model: "first" });
    wrapped.connect([], { model: "reload" });

    expect(sent).toEqual([{ model: "first", protectionTicket: "ticket-once" }, { model: "reload" }]);
    expect(pending.current).toBeUndefined();
  });
});
