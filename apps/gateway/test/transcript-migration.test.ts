import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const migrations = import.meta.glob("../drizzle/*.sql", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

it("upgrades existing transcripts without losing rows and allows IDs to repeat in different threads", async () => {
  const db = new PGlite();
  try {
    const ordered = Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b));
    const upgrade = ordered.findIndex(([name]) => name.includes("0014_"));
    expect(upgrade).toBeGreaterThan(0);
    for (const [, sql] of ordered.slice(0, upgrade)) await db.exec(sql);
    await db.exec(`
      INSERT INTO threads (id, user_id, org_id) VALUES ('old-a', 'a', 'a'), ('old-b', 'b', 'b');
      INSERT INTO messages (id, thread_id, role, parts, order_idx)
        VALUES ('shared', 'old-a', 'user', '[{"type":"text","content":"original"}]', 0);
    `);
    await db.exec(ordered[upgrade]![1]);
    await db.exec(`INSERT INTO messages (id, thread_id, role, parts, order_idx)
      VALUES ('shared', 'old-b', 'user', '[{"type":"text","content":"separate"}]', 0)`);
    expect((await db.query("SELECT revision FROM threads ORDER BY id")).rows).toEqual([
      { revision: 0 },
      { revision: 0 },
    ]);
    expect((await db.query("SELECT thread_id, parts FROM messages ORDER BY thread_id")).rows).toEqual([
      { thread_id: "old-a", parts: [{ type: "text", content: "original" }] },
      { thread_id: "old-b", parts: [{ type: "text", content: "separate" }] },
    ]);
  } finally {
    await db.close();
  }
});
