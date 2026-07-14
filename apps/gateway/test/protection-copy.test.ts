import { describe, expect, it } from "vitest";
import { emptyStateProtectionCopy, protectionPresentation } from "@/lib/protection-copy";
import type { ProtectionStatus } from "@/lib/protection-status";

function healthyStatus(): ProtectionStatus {
  return {
    ok: true,
    service: "ficta",
    protection: { enabled: true, protecting: true, registeredValues: 3, policyExcluded: 0 },
    secretShapes: { enabled: true, status: "ok", message: "active" },
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

describe("protection copy", () => {
  it("does not promise protection before posture is known", () => {
    expect(emptyStateProtectionCopy(undefined)).toBe(
      "Start drafting while ficta checks which protection layers are available.",
    );
    expect(protectionPresentation(undefined).label).toBe("Checking…");
  });

  it("names the active protection layers in the healthy state", () => {
    expect(emptyStateProtectionCopy(healthyStatus())).toBe(
      "ficta replaces registered secrets, known secret shapes, and detected personal information before the message reaches the AI provider, then restores protected values in the answer.",
    );
  });

  it("states the limit when no protection layer is active", () => {
    const status = healthyStatus();
    if (!status.ok) throw new Error("expected healthy status");
    status.protection = { ...status.protection, protecting: false, registeredValues: 0 };
    status.secretShapes = { ...status.secretShapes, enabled: false, status: "off" };
    status.pii = { ...status.pii, enabled: false, status: "off" };

    expect(emptyStateProtectionCopy(status)).toBe(
      "No protection layer is active yet, so messages would reach the AI provider unchanged.",
    );
    expect(protectionPresentation(status).label).toBe("No active protection");
  });

  it("describes active personal-information detection without implying registered secrets", () => {
    const status = healthyStatus();
    if (!status.ok) throw new Error("expected healthy status");
    status.protection = { ...status.protection, registeredValues: 0 };
    status.secretShapes = { ...status.secretShapes, enabled: false, status: "off" };

    expect(emptyStateProtectionCopy(status)).toBe(
      "ficta replaces detected personal information before the message reaches the AI provider, then restores protected values in the answer.",
    );
    expect(protectionPresentation(status).label).toBe("Protected");
  });

  it("describes degraded and blocked states without absolute claims", () => {
    const degraded = healthyStatus();
    if (!degraded.ok) throw new Error("expected healthy status");
    degraded.pii = { ...degraded.pii, status: "degraded" };
    expect(emptyStateProtectionCopy(degraded)).toContain("Personal-information detection is temporarily unavailable");
    expect(emptyStateProtectionCopy(degraded)).toContain("Registered secrets and known secret shapes remain protected");

    const blocked = healthyStatus();
    if (!blocked.ok) throw new Error("expected healthy status");
    blocked.pii = { ...blocked.pii, status: "blocking" };
    expect(protectionPresentation(blocked).label).toBe("Sending paused");
    expect(emptyStateProtectionCopy(blocked)).toContain("Sending is paused");
  });

  it("pauses sending when the deployment requires an unready registry", () => {
    const empty = healthyStatus();
    if (!empty.ok) throw new Error("expected healthy status");
    empty.registry = {
      required: true,
      status: "empty",
      message: "This deployment requires registered protected values, but none are loaded.",
    };

    expect(protectionPresentation(empty)).toMatchObject({ tone: "danger", label: "Sending paused" });
    expect(emptyStateProtectionCopy(empty)).toContain("Sending is paused");
    expect(emptyStateProtectionCopy(empty)).toContain("requires registered protected values");
  });

  it("keeps drafting separate from sending when the proxy is unavailable", () => {
    const status: ProtectionStatus = {
      ok: false,
      status: "unreachable",
      message: "offline",
      proxyUrl: "http://127.0.0.1:8787",
    };
    expect(emptyStateProtectionCopy(status)).toContain("You can draft here");
    expect(emptyStateProtectionCopy(status)).toContain("sending stays paused");
  });
});
