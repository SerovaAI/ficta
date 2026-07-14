import { isRegistryReloadOk } from "@serovaai/ficta-protocol";
import { describe, expect, it } from "vitest";
import { verifyRegistryReload } from "@/lib/storage/protected-registry";
import { renderManagedRegistryFile } from "@/lib/storage/protected-registry-render.server";
import type { ProtectedRegistryEntry } from "@/lib/storage/types";

function registryEntry(patch: Partial<ProtectedRegistryEntry> = {}): ProtectedRegistryEntry {
  return {
    id: "entity-1",
    matterId: "gateway-local-matter",
    type: "client",
    protectionKind: "entity",
    entityType: "organization",
    value: "Northstar Biologics",
    forms: [{ value: "Northstar", kind: "short_name", boundary: "token" }],
    source: "manual",
    status: "approved",
    createdBy: "admin",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...patch,
  };
}

// The publish flow's contract seam with the proxy: the gateway treats any payload this guard rejects
// as `bad_response` (partial success — the registry file is still written, the UI shows restart
// guidance). The proxy-side behavior (reload → live redaction, counts-only response) is covered
// end-to-end in packages/ficta/test/registry-reload.test.ts.
describe("isRegistryReloadOk", () => {
  it("publishes only the identity/form contract and keeps Gateway-local scope metadata out", () => {
    const rendered = renderManagedRegistryFile([
      registryEntry(),
      registryEntry({
        id: "literal-1",
        protectionKind: "literal",
        entityType: undefined,
        type: "account",
        value: "ZA-12345",
        forms: [],
      }),
    ]);
    const file = JSON.parse(rendered.body);

    expect(file.schema).toBe("ficta.managed-registry.v1");
    expect(file.entries).toEqual([
      {
        id: "entity-1",
        protectionKind: "entity",
        entityType: "organization",
        canonicalValue: "Northstar Biologics",
        forms: [{ value: "Northstar", kind: "short_name", boundary: "token" }],
      },
      {
        id: "literal-1",
        protectionKind: "literal",
        value: "ZA-12345",
        semanticType: "account",
      },
    ]);
    expect(rendered.values).toBe(3);
    expect(rendered.body).not.toContain("gateway-local-matter");
  });

  it("rejects normalized entity-form conflicts before publication", () => {
    expect(() =>
      renderManagedRegistryFile([
        registryEntry(),
        registryEntry({
          id: "entity-2",
          value: "Proxima Medical",
          forms: [{ value: "  NORTHSTAR  ", kind: "alias", boundary: "substring" }],
        }),
      ]),
    ).toThrow("conflicting entity forms");
  });

  it("accepts the proxy's counts-only success payload", () => {
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 1, total: 12 } })).toBe(true);
    expect(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 0, total: 0 } })).toBe(true);
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
        filesRead: 1,
        filesMissing: 0,
        filesErrored: 0,
        revision: expected,
      },
    };
    expect(verifyRegistryReload(payload, expected)).toMatchObject({
      ok: true,
      revision: expected,
      total: 12,
      restartRequired: false,
    });
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
