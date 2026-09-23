import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  projectRoot,
  projectsFilePath,
  readProjectExcludeNames,
  writeProjectExcludeNames,
} from "../src/project-config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ficta-project-config-"));
}

describe("projectRoot", () => {
  it("walks up to the nearest directory holding .git", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    expect(projectRoot(join(repo, "apps", "web"))).toBe(projectRoot(repo));
    expect(projectRoot(repo).endsWith(repo.split("/").pop() ?? "")).toBe(true);
  });

  it("falls back to the directory itself outside a repository", () => {
    const dir = tempDir();
    expect(projectRoot(dir)).toBe(projectRoot(dir));
    expect(projectRoot(dir).endsWith(dir.split("/").pop() ?? "")).toBe(true);
  });
});

describe("project exclusion store", () => {
  it("lives beside the config file and is disabled with it", () => {
    expect(projectsFilePath("/home/u/.ficta/config.toml")).toBe("/home/u/.ficta/projects.json");
    expect(projectsFilePath(undefined)).toBeUndefined();
  });

  it("round-trips per-project lists without touching other projects, 0600", () => {
    const path = join(tempDir(), "projects.json");
    writeProjectExcludeNames(path, "/repo/a", "PREVIEW_DOMAIN,SITE_URL");
    writeProjectExcludeNames(path, "/repo/b", "API_URL");

    expect(readProjectExcludeNames(path, "/repo/a")).toBe("PREVIEW_DOMAIN,SITE_URL");
    expect(readProjectExcludeNames(path, "/repo/b")).toBe("API_URL");
    expect(readProjectExcludeNames(path, "/repo/c")).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeProjectExcludeNames(path, "/repo/a", "");
    expect(readProjectExcludeNames(path, "/repo/a")).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).projects).toEqual({ "/repo/b": { exclude_names: ["API_URL"] } });
  });

  it("refuses to read or overwrite a corrupt store", () => {
    const path = join(tempDir(), "projects.json");
    writeFileSync(path, "{ not json");
    expect(() => readProjectExcludeNames(path, "/repo/a")).toThrow(/not valid JSON/);
    expect(() => writeProjectExcludeNames(path, "/repo/a", "X")).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("loadUserConfig — project layer", () => {
  it("loads the launch project's list from projects.json beside the config file", async () => {
    const { vi } = await import("vitest");
    const home = tempDir();
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    const configFile = join(home, "config.toml");
    writeFileSync(configFile, '[registry]\nexclude_names = ["GLOBAL_ONE"]\n');
    writeProjectExcludeNames(join(home, "projects.json"), projectRoot(repo), "PREVIEW_DOMAIN");

    const saved = {
      config: process.env.FICTA_CONFIG_FILE,
      global: process.env.FICTA_REGISTRY_EXCLUDE_NAMES,
      project: process.env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES,
    };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repo);
    try {
      process.env.FICTA_CONFIG_FILE = configFile;
      delete process.env.FICTA_REGISTRY_EXCLUDE_NAMES;
      delete process.env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES;
      vi.resetModules();
      const { loadUserConfig } = await import("../src/user-config.js");
      loadUserConfig();
      expect(process.env.FICTA_REGISTRY_EXCLUDE_NAMES).toBe("GLOBAL_ONE");
      expect(process.env.FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES).toBe("PREVIEW_DOMAIN");
    } finally {
      cwd.mockRestore();
      for (const [key, value] of [
        ["FICTA_CONFIG_FILE", saved.config],
        ["FICTA_REGISTRY_EXCLUDE_NAMES", saved.global],
        ["FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES", saved.project],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
