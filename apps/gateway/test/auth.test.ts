import { describe, expect, it } from "vitest";
import { deploymentOrganizationId } from "@/lib/auth/deployment-organization.server";
import { scopeFromAuth } from "@/lib/auth/guards.server";
import { type AuthState, isAdmin, LOCAL_AUTH_STATE } from "@/lib/auth/types";

describe("auth state", () => {
  it("represents none mode as a local admin user without changing local storage scope", () => {
    expect(LOCAL_AUTH_STATE.user?.id).toBe("local");
    expect(isAdmin(LOCAL_AUTH_STATE)).toBe(true);
    expect(scopeFromAuth(LOCAL_AUTH_STATE)).toEqual({ userId: "local", orgId: "local" });
  });

  it("requires an admin role claim for hosted organization admins", () => {
    const member: AuthState = {
      provider: "workos",
      requiresAuth: true,
      user: { id: "user_1", email: "member@example.com", organizationId: "org_1", role: "member" },
    };
    const admin: AuthState = {
      provider: "workos",
      requiresAuth: true,
      user: { id: "user_1", email: "admin@example.com", organizationId: "org_1", roles: ["admin"] },
    };

    expect(isAdmin(member)).toBe(false);
    expect(isAdmin(admin)).toBe(true);
    expect(scopeFromAuth(member)).toEqual({ userId: "user_1", orgId: "org_1" });
  });

  it("rejects a session active in a different organization from the deployment", () => {
    const mismatch: AuthState = {
      provider: "workos",
      requiresAuth: true,
      user: { id: "user_1", email: "member@example.com", organizationId: "org_other", role: "member" },
      organizationMode: "single",
      organizationAllowed: false,
    };
    expect(scopeFromAuth(mismatch)).toBeNull();
  });

  it("requires a valid organization binding for hosted deployments", () => {
    expect(() => deploymentOrganizationId({})).toThrow("FICTA_GATEWAY_ORG_ID is required");
    expect(() => deploymentOrganizationId({ FICTA_GATEWAY_ORG_ID: "org allowed" })).toThrow(
      "FICTA_GATEWAY_ORG_ID is invalid",
    );
    expect(() => deploymentOrganizationId({ FICTA_GATEWAY_ORG_ID: "workspace_01ABC" })).toThrow(
      "expected a WorkOS org_... identifier",
    );
    expect(deploymentOrganizationId({ FICTA_GATEWAY_ORG_ID: "org_01ABC" })).toBe("org_01ABC");
  });
});
