import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProtectionStats } from "../src/protection-stats.js";

describe("protection stats label accounting", () => {
  it("counts distinct protected values rather than deduplicated labels", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ficta-protection-stats-")), "stats.json");
    const stats = new ProtectionStats(path);
    const person = {
      name: "person",
      source: "pii-presidio",
      plugin: "pii",
      kind: "pii" as const,
      confidence: "high" as const,
    };
    const email = { ...person, name: "email-address" };

    stats.record({
      requestId: 1,
      method: "POST",
      path: "/v1/responses",
      wire: "openai-responses",
      surface: "body",
      redactedValues: 4,
      survivingValues: 0,
      blocked: false,
      redactedHits: [person, person, person, email],
    });

    const snapshot = stats.snapshot();
    expect(snapshot.byLabel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "person", redactedValues: 3, keptOutOfModelValues: 3 }),
        expect.objectContaining({ name: "email-address", redactedValues: 1, keptOutOfModelValues: 1 }),
      ]),
    );
    expect(snapshot.byLabel.reduce((sum, bucket) => sum + bucket.redactedValues, 0)).toBe(
      snapshot.totals.redactedValues,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ totals: { redactedValues: 4 } });
  });
});
