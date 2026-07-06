import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePgliteDataDirLock, assertPgliteReadable } from "@/lib/storage/drizzle/pglite-guard.server";

const tempRoots: string[] = [];

function makeTempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ficta-pglite-guard-"));
  tempRoots.push(root);
  const dataDir = join(root, "pglite");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function lockPathFor(dataDir: string): string {
  return `${resolve(dataDir)}.lock`;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("PGlite data directory guard", () => {
  it("skips non-filesystem PGlite data dirs", () => {
    expect(acquirePgliteDataDirLock("memory://")).toBeUndefined();
  });

  it("creates and releases a filesystem data-dir lock", () => {
    const dataDir = makeTempDataDir();
    const lock = acquirePgliteDataDirLock(dataDir);

    expect(lock?.lockPath).toBe(lockPathFor(dataDir));
    expect(existsSync(lockPathFor(dataDir))).toBe(true);

    lock?.release();
    expect(existsSync(lockPathFor(dataDir))).toBe(false);
  });

  it("rejects a second live owner for the same filesystem data dir", () => {
    const dataDir = makeTempDataDir();
    const lock = acquirePgliteDataDirLock(dataDir);

    expect(() => acquirePgliteDataDirLock(dataDir)).toThrow(/already in use by pid/);

    lock?.release();
  });

  it("removes a stale owner lock before acquiring", () => {
    const dataDir = makeTempDataDir();
    writeFileSync(
      lockPathFor(dataDir),
      JSON.stringify({
        dataDir,
        owner: "stale",
        pid: 0,
        startedAt: new Date(0).toISOString(),
      }),
    );

    const lock = acquirePgliteDataDirLock(dataDir);

    expect(lock).toBeDefined();
    expect(existsSync(lockPathFor(dataDir))).toBe(true);

    lock?.release();
  });

  it("wraps failed startup probes with recovery guidance", async () => {
    const dataDir = makeTempDataDir();

    await expect(
      assertPgliteReadable(dataDir, async () => {
        throw new Error("Aborted()");
      }),
    ).rejects.toThrow(/appears unreadable or corrupt/);
  });
});
