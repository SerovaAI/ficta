import { randomUUID } from "node:crypto";
import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A leftover temp older than this was orphaned by a crash mid-write, not an in-flight writer. */
const STALE_TEMP_MS = 60_000;

/**
 * Replace a sensitive file atomically. The temporary file is created in the destination directory so
 * rename is one filesystem operation; readers observe either the previous complete generation or the
 * next complete generation, never a torn JSON document. Creating the temp at 0600 also repairs an
 * overly-permissive existing destination when rename replaces it.
 */
export async function writePrivateFileAtomic(path: string, body: string): Promise<void> {
  await removeStaleTemps(path);
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Best-effort removal of temp files orphaned by a crash between write and rename. The age threshold
 * keeps a concurrent writer's in-flight temp (alive for milliseconds) safe from deletion.
 */
async function removeStaleTemps(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const stale = join(dir, entry);
    try {
      if (Date.now() - (await stat(stale)).mtimeMs > STALE_TEMP_MS) await unlink(stale);
    } catch {
      // Already gone or unreadable — either way not ours to insist on.
    }
  }
}

/** A tiny in-process mutex: publication must keep write → reload acknowledgement as one transaction. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
