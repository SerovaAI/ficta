import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PgliteDataDirLock {
  lockPath: string;
  release: () => void;
}

interface LockFile {
  dataDir: string;
  owner: string;
  pid: number;
  startedAt: string;
}

function isFilesystemDataDir(dataDir: string): boolean {
  return !dataDir.includes("://");
}

function lockPathFor(dataDir: string): string {
  return `${resolve(dataDir)}.lock`;
}

function ownerToken(): string {
  return `${process.pid}:${Date.now()}:${randomUUID()}`;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readLock(lockPath: string): LockFile | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
  } catch {
    return undefined;
  }
}

function removeStaleLock(lockPath: string, lock: LockFile | undefined): boolean {
  if (!lock || isPidAlive(lock.pid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function createLockBusyError(dataDir: string, lockPath: string, lock: LockFile | undefined): Error {
  const owner = lock ? `pid ${lock.pid}` : "an unknown process";
  return new Error(
    [
      `PGlite data directory is already in use by ${owner}: ${dataDir}`,
      `PGlite is single-process for file-backed storage. Stop the other Gateway process or set DATABASE_URL for a shared Postgres database.`,
      `Lock file: ${lockPath}`,
    ].join("\n"),
  );
}

export function acquirePgliteDataDirLock(dataDir: string): PgliteDataDirLock | undefined {
  if (!isFilesystemDataDir(dataDir)) return undefined;

  const lockPath = lockPathFor(dataDir);
  const owner = ownerToken();
  const lock: LockFile = {
    dataDir: resolve(dataDir),
    owner,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return registerLock(lockPath, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const existing = readLock(lockPath);
      if (attempt === 0 && removeStaleLock(lockPath, existing)) continue;
      throw createLockBusyError(dataDir, lockPath, existing);
    }
  }

  throw createLockBusyError(dataDir, lockPath, readLock(lockPath));
}

function registerLock(lockPath: string, owner: string): PgliteDataDirLock {
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);

    const lock = readLock(lockPath);
    if (lock?.owner !== owner) return;

    try {
      unlinkSync(lockPath);
    } catch {}
  };

  process.once("exit", release);

  return { lockPath, release };
}

export async function assertPgliteReadable(dataDir: string, query: (sql: string) => Promise<unknown>): Promise<void> {
  if (!isFilesystemDataDir(dataDir)) return;

  try {
    await query("select 1");
  } catch (error) {
    throw new Error(
      [
        `PGlite data directory appears unreadable or corrupt: ${dataDir}`,
        `Move it aside and restart Gateway, or set DATABASE_URL to use a shared Postgres database.`,
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
      { cause: error },
    );
  }
}
