import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { ProtectedRegistrySection } from "@/components/settings/ProtectedRegistrySection";
import { Button } from "@/components/ui/button";
import { type AuthState, isAdmin } from "@/lib/auth/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";

export const Route = createFileRoute("/admin/protected-registry")({
  beforeLoad: ({ context }) => {
    const auth = (context as { auth?: AuthState }).auth;
    if (!auth || !isAdmin(auth)) throw redirect({ to: "/" });
  },
  head: () => ({
    meta: [{ title: "Protected Registry | ficta chat" }],
  }),
  component: ProtectedRegistryPage,
});

function ProtectedRegistryPage() {
  const { instanceName } = useInstanceSettings();

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button asChild variant="ghost" size="sm" className="-ml-2">
              <Link to="/">
                <ArrowLeft className="size-4" aria-hidden />
                Chat
              </Link>
            </Button>
            <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-muted-foreground text-xs font-medium">
              <ShieldCheck className="size-3.5" aria-hidden />
              Admin-only
            </span>
          </div>

          <div className="max-w-3xl">
            {instanceName ? <p className="text-muted-foreground text-sm">{instanceName}</p> : null}
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Protected Registry</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
              Import, review, and export known sensitive values that ficta should protect by exact match before prompts
              leave this workspace.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <ProtectedRegistrySection showHeader={false} />
      </div>
    </main>
  );
}
