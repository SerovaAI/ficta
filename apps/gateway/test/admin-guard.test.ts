import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "@/lib/auth/types";

let authState: AuthState = {
  provider: "workos",
  requiresAuth: true,
  user: { id: "user_1", email: "member@example.com", organizationId: "org_1", role: "member" },
};

vi.mock("@/lib/auth/provider.server", () => ({
  getActiveProvider: async () => ({
    getAuthState: async () => authState,
  }),
}));

describe("admin guard", () => {
  it("rejects hosted non-admin sessions", async () => {
    const { requireAdminScope } = await import("@/lib/auth/guards.server");
    await expect(requireAdminScope()).rejects.toThrow("forbidden");
  });

  it("allows hosted admin sessions and returns their storage scope", async () => {
    authState = {
      provider: "workos",
      requiresAuth: true,
      user: { id: "user_1", email: "admin@example.com", organizationId: "org_1", roles: ["admin"] },
    };
    const { requireAdminScope } = await import("@/lib/auth/guards.server");
    await expect(requireAdminScope()).resolves.toEqual({ userId: "user_1", orgId: "org_1" });
  });

  it("allows a records user without granting administrator access", async () => {
    authState = {
      provider: "workos",
      requiresAuth: true,
      user: {
        id: "records_1",
        email: "records@example.com",
        organizationId: "org_1",
        role: "member",
        permissions: ["retained-threads:list"],
      },
    };
    const { requireAdminScope, requireRecordsScope } = await import("@/lib/auth/guards.server");
    await expect(requireAdminScope()).rejects.toThrow("forbidden");
    await expect(requireRecordsScope("retained-threads:list")).resolves.toEqual({
      userId: "records_1",
      actorUserId: "records_1",
      orgId: "org_1",
    });
  });

  it("does not let administrator status imply records access", async () => {
    authState = {
      provider: "workos",
      requiresAuth: true,
      user: { id: "admin_1", email: "admin@example.com", organizationId: "org_1", role: "admin" },
    };
    const { requireRecordsScope } = await import("@/lib/auth/guards.server");
    await expect(requireRecordsScope("retained-threads:list")).rejects.toThrow("forbidden");
  });
});
