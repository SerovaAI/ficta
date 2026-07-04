import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = fileURLToPath(new URL("./src", import.meta.url));
const serverFnModules = findServerFnModules(srcRoot);

export default defineConfig(({ mode }) => {
  // Load apps/gateway/.env (all keys, no VITE_ prefix) into the *server* process, so the /api/chat
  // handler can read OPENAI_API_KEY / ANTHROPIC_API_KEY / FICTA_PROXY_URL via process.env. A real
  // shell export still wins. These never enter the client bundle — only server-only code reads them.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    // 4747 is deliberately uncommon: WORKOS_REDIRECT_URI is registered statically in the WorkOS
    // dashboard, so the port must never drift. strictPort fails loudly instead of falling back.
    server: { port: 4747, strictPort: true },
    resolve: {
      // `@` → src, so shadcn/ui-generated imports (`@/components/...`, `@/lib/utils`) resolve.
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [
      tanstackStart(),
      warmTanStackServerFns(serverFnModules),
      // React's Vite plugin must come after TanStack Start's plugin.
      viteReact(),
      // Tailwind v4 scans classes and emits CSS; runs last.
      tailwindcss(),
    ],
  };
});

function warmTanStackServerFns(modules: string[]): Plugin {
  return {
    name: "ficta:warm-tanstack-server-fns",
    apply: "serve",
    async configureServer(server) {
      const failed: string[] = [];
      for (const moduleId of modules) {
        try {
          await server.transformRequest(moduleId);
        } catch {
          failed.push(moduleId);
        }
      }
      if (failed.length > 0) {
        server.config.logger.warn(`[gateway] could not prewarm TanStack server functions: ${failed.join(", ")}`);
      }
    },
    async handleHotUpdate(ctx) {
      if (!isSourceModule(ctx.file)) return;
      const code = readFileSync(ctx.file, "utf8");
      if (!code.includes("createServerFn")) return;
      await ctx.server.transformRequest(fileToViteModuleId(ctx.file));
    },
  };
}

function findServerFnModules(dir: string): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const moduleId of findServerFnModules(path)) modules.push(moduleId);
      continue;
    }
    if (!isSourceModule(path)) continue;
    if (readFileSync(path, "utf8").includes("createServerFn")) modules.push(fileToViteModuleId(path));
  }
  return modules.sort();
}

function isSourceModule(path: string): boolean {
  return /\.(?:ts|tsx)$/.test(path);
}

function fileToViteModuleId(path: string): string {
  return `/${relative(appRoot, path).replaceAll("\\", "/")}`;
}
