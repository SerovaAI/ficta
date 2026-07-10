import { isRegistryReloadOk } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { verifyRegistryReload } from "@/lib/storage/protected-registry";

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

  it("only confirms publication when the exact revision was loaded without source errors", () => {
    const expected = "revision-123";
    const payload = {
      ok: true,
      service: "ficta",
      registry: {
        added: 0,
        total: 12,
        loaded: 10,
        skippedTooShort: 2,
        filesRead: 1,
        filesMissing: 0,
        filesErrored: 0,
        revision: expected,
      },
    };
    expect(verifyRegistryReload(payload, expected)).toMatchObject({ ok: true, revision: expected, total: 12 });
    expect(
      verifyRegistryReload({ ...payload, registry: { ...payload.registry, revision: undefined } }, expected),
    ).toMatchObject({
      ok: false,
      status: "not_applied",
    });
    expect(
      verifyRegistryReload({ ...payload, registry: { ...payload.registry, filesErrored: 1 } }, expected),
    ).toMatchObject({
      ok: false,
      status: "source_error",
    });
  });

  it("downgrades a missing secondary file to a warning when the published revision verified", () => {
    // The revision only matches a parsed file, so a missing path is never this publish's own file.
    const expected = "revision-123";
    const result = verifyRegistryReload(
      {
        ok: true,
        service: "ficta",
        registry: {
          added: 3,
          total: 12,
          loaded: 10,
          skippedTooShort: 0,
          filesRead: 1,
          filesMissing: 1,
          filesErrored: 0,
          revision: expected,
        },
      },
      expected,
    );
    expect(result).toMatchObject({ ok: true, revision: expected, filesMissing: 1 });
  });

  it("treats an older counts-only proxy response as unverified partial success", () => {
    expect(
      verifyRegistryReload({ ok: true, service: "ficta", registry: { added: 1, total: 2 } }, "revision-123"),
    ).toMatchObject({ ok: false, status: "bad_response" });
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
