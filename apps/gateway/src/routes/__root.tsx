import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, redirect, Scripts } from "@tanstack/react-router";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/fragment-mono";
import { Button } from "@/components/ui/button";
import { fetchAuthState } from "@/lib/auth/auth";
import { organizationsQueryOptions } from "@/lib/auth/organizationQueries";
import { fetchIssueReportingAvailability } from "@/lib/issue-reporting";
import { fetchInstanceSettings } from "@/lib/storage/settings";
import styles from "@/styles.css?url";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Resolve auth once at the top of the tree: gate the whole app when the provider requires it, and
  // seed router context so any component can read the current user (see useAuthState). In `none` mode
  // this returns an open state and never redirects. `/api/auth/*` are server routes and don't run this,
  // so the redirect target can't loop.
  beforeLoad: async ({ context, location }) => {
    // Resolve auth first and gate before doing anything else — an unauthenticated user shouldn't trigger
    // instance-settings work. Both land in router context so components read them without refetching.
    const auth = await fetchAuthState();
    if (auth.requiresAuth && !auth.user) {
      const returnPathname = encodeURIComponent(location.pathname + location.searchStr);
      throw redirect({ href: `/api/auth/sign-in?returnPathname=${returnPathname}` });
    }
    const organizationReady = Boolean(auth.user?.organizationId) && auth.organizationAllowed !== false;
    if (auth.requiresAuth && auth.user && !organizationReady && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
    if (auth.requiresAuth && organizationReady && location.pathname === "/onboarding") {
      throw redirect({ to: "/" });
    }
    if (auth.requiresAuth && organizationReady) {
      void context.queryClient.prefetchQuery(organizationsQueryOptions);
    }
    const [instance, issueReporting] = await Promise.all([fetchInstanceSettings(), fetchIssueReportingAvailability()]);
    return { auth, instance, issueReporting };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "ficta chat" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
  notFoundComponent: NotFoundPage,
});

// Set the theme before first paint to avoid a flash: honor a saved choice, else follow the OS.
const THEME_INIT = `(()=>{try{const t=localStorage.getItem("ficta-theme");const dark=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",dark);}catch{}})()`;

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, self-authored theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

function NotFoundPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          This route does not exist in ficta chat. Start a new chat or choose one from your history.
        </p>
        <Button asChild className="mt-5">
          <Link to="/">Go to chat</Link>
        </Button>
      </section>
    </main>
  );
}
