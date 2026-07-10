import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { CreateWorkspaceForm } from "@/components/onboarding/CreateWorkspaceForm";
import { Button } from "@/components/ui/button";
import { fetchOrganizations, switchOrganization } from "@/lib/auth/auth";
import type { OrgSummary } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";

export const Route = createFileRoute("/onboarding")({
  loader: () => fetchOrganizations(),
  component: OnboardingPage,
});

function OnboardingPage() {
  const orgs = Route.useLoaderData();
  const auth = useAuthState();
  const singleOrganization = auth.organizationMode === "single";
  const [showCreate, setShowCreate] = useState(orgs.length === 0);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const hasOrgs = orgs.length > 0;

  const continueToOrg = async (org: OrgSummary) => {
    if (switchingOrgId) return;
    setSwitchingOrgId(org.id);
    setError(undefined);
    try {
      await switchOrganization({ data: { organizationId: org.id } });
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch workspace");
      setSwitchingOrgId(null);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-secondary">
          <ShieldCheck className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden />
        </div>
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {singleOrganization ? "Open your organization" : "Create your workspace"}
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            {singleOrganization
              ? "This Gateway and its redaction proxy are assigned to one organization."
              : "Workspaces keep chats and settings scoped to the organization you are working in."}
          </p>
        </div>

        {hasOrgs ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">Continue with an existing workspace:</p>
              {orgs.map((org) => (
                <Button
                  key={org.id}
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => continueToOrg(org)}
                  disabled={switchingOrgId !== null}
                >
                  {switchingOrgId === org.id ? "Switching…" : `Continue to ${org.name}`}
                </Button>
              ))}
            </div>

            {error ? (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            {!singleOrganization && showCreate ? (
              <div className="border-border border-t pt-4">
                <CreateWorkspaceForm onCancel={() => setShowCreate(false)} />
              </div>
            ) : !singleOrganization ? (
              <Button type="button" variant="ghost" className="w-full" onClick={() => setShowCreate(true)}>
                Create a new workspace
              </Button>
            ) : null}
          </div>
        ) : singleOrganization ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm" role="status">
              <p className="font-medium">Organization access required</p>
              <p className="mt-1 text-muted-foreground leading-relaxed">
                Ask your WorkOS administrator to add this account to the organization assigned to this Gateway, then
                sign in again.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => window.location.assign("/api/auth/sign-out")}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <CreateWorkspaceForm />
        )}
      </section>
    </main>
  );
}
