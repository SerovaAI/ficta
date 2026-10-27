import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Per-package module cache: the workspace-root default is shared by turbo's parallel vitest runs,
    // which all wipe it at once after a lockfile change and race (ENOTEMPTY).
    fsModuleCachePath: "node_modules/.vitest-cache",
  },
});
