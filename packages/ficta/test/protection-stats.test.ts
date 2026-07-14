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

  it("records a values-free fail-closed detector outage with zero value counts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ficta-protection-stats-")), "stats.json");
    const stats = new ProtectionStats(path);

    stats.record({
      requestId: 7,
      method: "POST",
      path: "/v1/responses",
      wire: "openai-responses",
      surface: "body",
      redactedValues: 0,
      survivingValues: 0,
      blocked: true,
      blockReason: "detector_unavailable",
    });

    expect(stats.snapshot()).toMatchObject({
      totals: {
        events: 1,
        affectedRequests: 1,
        blockedRequests: 1,
        redactedValues: 0,
        survivingValues: 0,
        keptOutOfModelValues: 0,
      },
      events: [{ requestId: 7, blocked: true, blockReason: "detector_unavailable" }],
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      totals: { blockedRequests: 1 },
      events: [{ blockReason: "detector_unavailable" }],
    });
  });

  it("counts ambiguous entity occurrences and affected requests without storing mention values", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ficta-protection-stats-")), "stats.json");
    const stats = new ProtectionStats(path);
    const base = {
      method: "POST",
      path: "/v1/responses",
      wire: "openai-responses" as const,
      surface: "body" as const,
      redactedValues: 1,
      survivingValues: 0,
      blocked: false,
    };

    stats.record({ ...base, requestId: 11, ambiguousEntityLinks: 2 });
    stats.record({ ...base, requestId: 11, ambiguousEntityLinks: 1 });
    stats.record({ ...base, requestId: 12, ambiguousEntityLinks: 1 });

    const snapshot = stats.snapshot();
    expect(snapshot.totals).toMatchObject({
      ambiguousEntityLinks: 4,
      ambiguousEntityLinkRequests: 2,
    });
    expect(snapshot.events.map((event) => event.ambiguousEntityLinks)).toEqual([2, 1, 1]);
    expect(readFileSync(path, "utf8")).not.toContain("Northstar");
  });
});
