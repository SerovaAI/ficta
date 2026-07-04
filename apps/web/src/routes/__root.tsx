import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/fragment-mono";
import styles from "@/styles.css?url";

const DESCRIPTION =
  "ficta is a local redaction gateway for model traffic. It tokenizes registered secrets, secret-shaped keys, and detected PII before a request reaches the model — and restores the real values locally in the reply.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "ficta — a local redaction gateway for model traffic" },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#0a0a0c" },
      { property: "og:title", content: "ficta — a local redaction gateway for model traffic" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://ficta.sh/" },
      { property: "og:image", content: "https://ficta.sh/og.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: "ficta — the model sees a token. You keep the value. A bearer secret becoming a FICTA_ surrogate.",
      },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
});

// The site is dark-only by design; `.dark` on <html> activates shadcn's dark: utilities.
function RootDocument() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
