import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/fragment-mono";
import type * as React from "react";
import styles from "@/styles.css?url";

const SITE_TITLE = "ficta Gateway — self-hosted redaction for AI chat";
const DESCRIPTION =
  "ficta Gateway is a self-hosted AI workspace with a local redaction boundary for model traffic. It tokenizes registered secrets, sensitive identifiers, and detected PII before a request reaches the model — and restores the real values locally in the reply.";
const CONTACT_EMAIL = "hello@ficta.sh";
const CONTACT = `mailto:${CONTACT_EMAIL}?subject=ficta%20Gateway`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: SITE_TITLE },
      { name: "application-name", content: "ficta Gateway" },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index,follow" },
      { name: "theme-color", content: "#0a0a0c" },
      { property: "og:title", content: SITE_TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://ficta.sh/" },
      { property: "og:site_name", content: "ficta" },
      { property: "og:image", content: "https://ficta.sh/og.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content:
          "ficta Gateway — AI chat behind your redaction boundary. A protected value becoming a FICTA_ surrogate.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: SITE_TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: "https://ficta.sh/og.png" },
      {
        name: "twitter:image:alt",
        content:
          "ficta Gateway — AI chat behind your redaction boundary. A protected value becoming a FICTA_ surrogate.",
      },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "canonical", href: "https://ficta.sh/" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

// The site is dark-only by design; `.dark` on <html> activates shadcn's dark: utilities.
function RootDocument() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <noscript>
          <div className="border-border border-b bg-card px-5 py-3 text-muted-foreground text-sm">
            JavaScript is disabled. Page links still work; copy buttons are unavailable, but the install command and
            email address are visible for manual copy.
          </div>
        </noscript>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const message = error instanceof Error ? error.message : "Unknown render error";

  return (
    <FallbackPage
      eyebrow="render boundary"
      title="The page failed before it could finish rendering."
      body="Try the page again. If it keeps failing, email the exact URL and browser to the founder so the broken surface can be fixed."
      detail={import.meta.env.DEV ? message : undefined}
      action={
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-6 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Try again
        </button>
      }
    />
  );
}

function NotFound() {
  return (
    <FallbackPage
      eyebrow="404"
      title="That ficta page does not exist."
      body="The public site is intentionally small. Start from the Gateway page, or contact us if you followed a stale product or documentation link."
      action={
        <a
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-6 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Back to Gateway
        </a>
      }
    />
  );
}

function FallbackPage({
  eyebrow,
  title,
  body,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  detail?: string;
  action: React.ReactNode;
}) {
  return (
    <main id="main" className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
        <a
          href="/"
          aria-label="ficta home"
          className="inline-flex items-baseline font-mono text-[1.05rem] tracking-tight"
        >
          <span aria-hidden className="text-primary">
            [
          </span>
          <span className="text-foreground">ficta</span>
          <span aria-hidden className="text-primary">
            ]
          </span>
        </a>
        <section className="mt-24 border-border/60 border-t pt-12 sm:mt-32">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest">{eyebrow}</p>
          <h1 className="mt-5 max-w-2xl font-semibold text-[clamp(2rem,5vw,3rem)] leading-tight">{title}</h1>
          <p className="mt-5 max-w-2xl text-muted-foreground leading-relaxed">{body}</p>
          {detail ? (
            <pre className="mt-6 max-w-full overflow-x-auto rounded-lg border border-border bg-card/70 p-4 font-mono text-muted-foreground text-xs leading-relaxed">
              <code>{detail}</code>
            </pre>
          ) : null}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {action}
            <a
              href={CONTACT}
              className="inline-flex min-h-11 items-center text-muted-foreground text-sm underline decoration-primary/50 underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              Email {CONTACT_EMAIL}
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
