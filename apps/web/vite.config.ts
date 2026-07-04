import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // 4748 sits next to the gateway's 4747 so both can run side by side under `turbo run dev`.
  server: { port: 4748, strictPort: true },
  resolve: {
    // `@` → src, so shadcn/ui-generated imports (`@/components/...`, `@/lib/utils`) resolve.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    // Targets Cloudflare Workers: runs the SSR environment under workerd in dev, and produces a
    // Worker + static assets bundle on build (deployed via wrangler). Reads wrangler.jsonc.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    // React's Vite plugin must come after TanStack Start's plugin.
    viteReact(),
    // Tailwind v4 scans classes and emits CSS; runs last.
    tailwindcss(),
  ],
});
