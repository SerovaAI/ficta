import { chmod, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SerialTaskQueue, writePrivateFileAtomic } from "@/lib/storage/private-file.server";

describe("private atomic files", () => {
  it("atomically replaces an existing file and repairs its permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ficta-private-file-"));
    const path = join(dir, "protected-registry.json");
    await writeFile(path, "old", { mode: 0o644 });
    await chmod(path, 0o644);

    await writePrivateFileAtomic(path, '{"revision":"next"}\n');

    expect(await readFile(path, "utf8")).toBe('{"revision":"next"}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes crash-orphaned temp files but leaves recent in-flight temps alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ficta-private-file-"));
    const path = join(dir, "protected-registry.json");
    const orphan = join(dir, ".protected-registry.json.dead-writer.tmp");
    const inFlight = join(dir, ".protected-registry.json.live-writer.tmp");
    await writeFile(orphan, "torn", { mode: 0o600 });
    const stale = new Date(Date.now() - 5 * 60_000);
    await utimes(orphan, stale, stale);
    await writeFile(inFlight, "concurrent", { mode: 0o600 });

    await writePrivateFileAtomic(path, "{}\n");

    const temps = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(temps).toEqual([".protected-registry.json.live-writer.tmp"]);
  });

  it("serializes write-and-reload transactions in submission order", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    const first = queue.run(async () => {
      events.push("first:write");
      await Promise.resolve();
      events.push("first:reload");
    });
    const second = queue.run(async () => {
      events.push("second:write");
      events.push("second:reload");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first:write", "first:reload", "second:write", "second:reload"]);
  });
});
