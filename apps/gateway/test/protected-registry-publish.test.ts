import { isRegistryReloadOk } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";

// The publish flow's contract seam with the proxy: the gateway treats any payload this guard rejects
// as `bad_response` (partial success — the registry file is still written, the UI shows restart
// guidance). The proxy-side behavior (reload → live redaction, counts-only response) is covered
// end-to-end in packages/ficta/test/registry-reload.test.ts.
describe("isRegistryReloadOk", () => {
  it("accepts the proxy's counts-only success payload", () => {
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 1, total: 12 } })).toBe(true);
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 0, total: 0 } })).toBe(true);
    // skippedTooShort is optional (older proxies omit it) but must be a number when present.
    expect(
      isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 1, total: 2, skippedTooShort: 3 } }),
    ).toBe(true);
    expect(
      isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 1, total: 2, skippedTooShort: "3" } }),
    ).toBe(false);
  });

  it("rejects error payloads and foreign services", () => {
    expect(isRegistryReloadOk({ ok: false, service: "ficta", status: "forbidden", message: "loopback only" })).toBe(
      false,
    );
    expect(isRegistryReloadOk({ ok: true, service: "other", registry: { added: 1, total: 2 } })).toBe(false);
  });

  it("rejects malformed or missing counts", () => {
    expect(isRegistryReloadOk({ ok: true, service: "ficta" })).toBe(false);
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: {} })).toBe(false);
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: "1", total: 2 } })).toBe(false);
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 1 } })).toBe(false);
    expect(isRegistryReloadOk(null)).toBe(false);
  });
});
