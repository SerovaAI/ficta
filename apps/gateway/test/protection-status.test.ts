import { describe, expect, it } from "vitest";
import { isProtectionStatusOk, requiredRegistryBlock } from "@/lib/protection-status";

function validStatus() {
  return {
    ok: true,
    service: "ficta",
    protection: { enabled: true, protecting: true, registeredValues: 3, policyExcluded: 0 },
    secretShapes: { enabled: false, status: "off", message: "off" },
    pii: {
      enabled: true,
      configuredBackend: "regex",
      backend: "regex",
      status: "ok",
      failureMode: "fail-open",
      message: "active",
    },
  };
}

// `activity` is optional so an older proxy (pre-counters) and a newer web app interop; when present
// it must be well-typed or the whole payload fails closed to bad_response.
describe("isProtectionStatusOk", () => {
  it("accepts a payload without activity (older proxy)", () => {
    expect(isProtectionStatusOk(validStatus())).toBe(true);
  });

  it("accepts a payload with activity counters", () => {
    const status = { ...validStatus(), activity: { restoredValues: 4, withheldFromTools: 1 } };
    expect(isProtectionStatusOk(status)).toBe(true);
  });

  it("identifies only required, unready registries as blocking", () => {
    const emptyRequired = {
      ...validStatus(),
      registry: { required: true, status: "empty" as const, message: "publish the registry" },
    };
    expect(isProtectionStatusOk(emptyRequired)).toBe(true);
    expect(requiredRegistryBlock(emptyRequired)).toEqual(emptyRequired.registry);

    expect(
      requiredRegistryBlock({
        ...validStatus(),
        registry: { required: false, status: "empty", message: "optional" },
      }),
    ).toBeUndefined();
    expect(
      requiredRegistryBlock({
        ...validStatus(),
        registry: { required: true, status: "ready", message: "ready" },
      }),
    ).toBeUndefined();
  });

  it("rejects a mistyped activity section", () => {
    expect(isProtectionStatusOk({ ...validStatus(), activity: { restoredValues: "4", withheldFromTools: 1 } })).toBe(
      false,
    );
    expect(isProtectionStatusOk({ ...validStatus(), activity: { restoredValues: 4 } })).toBe(false);
    expect(isProtectionStatusOk({ ...validStatus(), activity: null })).toBe(false);
  });
});
