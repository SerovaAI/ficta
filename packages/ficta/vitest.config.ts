import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live, real-agent e2e suite is opt-in only — run it via `pnpm test:e2e`
    // (vitest.e2e.config.ts). It must never run in the default offline suite/CI.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // Per-package module cache: the workspace-root default is shared by turbo's parallel vitest runs,
    // which all wipe it at once after a lockfile change and race (ENOTEMPTY).
    fsModuleCachePath: "node_modules/.vitest-cache",
  },
});
