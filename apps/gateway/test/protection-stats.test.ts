import { describe, expect, it } from "vitest";
import { isProtectionStatsOk } from "@/lib/protection-stats";

function validPayload() {
  return {
    ok: true,
    service: "ficta",
    stats: {
      version: 1,
      path: "/tmp/ficta/stats.json",
      startedAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:01:00.000Z",
      totals: {
        events: 1,
        affectedRequests: 1,
        redactedValues: 1,
        survivingValues: 0,
        blockedRequests: 0,
        keptOutOfModelValues: 1,
        restoredValues: 1,
        withheldFromToolsValues: 0,
      },
      byModel: [bucket("gpt-5-mini")],
      bySurface: [bucket("body")],
      byWire: [bucket("openai")],
      byLabel: [{ ...bucket("EMAIL"), source: "pii-regex", plugin: "pii", kind: "pii", confidence: "high" }],
      events: [
        {
          index: 1,
          at: "2026-07-05T10:01:00.000Z",
          requestId: 7,
          method: "POST",
          path: "/v1/chat/completions",
          wire: "openai",
          route: "openai",
          model: "gpt-5-mini",
          surface: "body",
          redactedValues: 1,
          survivingValues: 0,
          blocked: false,
          redactedHits: [{ name: "EMAIL", source: "pii-regex", plugin: "pii", kind: "pii", confidence: "high" }],
          survivingHits: [],
        },
      ],
    },
  };
}

function bucket(name: string) {
  return {
    name,
    requests: 1,
    redactedValues: 1,
    survivingValues: 0,
    blockedRequests: 0,
    keptOutOfModelValues: 1,
  };
}

describe("isProtectionStatsOk", () => {
  it("accepts a well-formed redaction proof payload", () => {
    expect(isProtectionStatsOk(validPayload())).toBe(true);
  });

  it("accepts empty proof data from a fresh proxy run", () => {
    const payload = validPayload();
    payload.stats.totals = {
      events: 0,
      affectedRequests: 0,
      redactedValues: 0,
      survivingValues: 0,
      blockedRequests: 0,
      keptOutOfModelValues: 0,
      restoredValues: 0,
      withheldFromToolsValues: 0,
    };
    payload.stats.byModel = [];
    payload.stats.bySurface = [];
    payload.stats.byWire = [];
    payload.stats.byLabel = [];
    payload.stats.events = [];

    expect(isProtectionStatsOk(payload)).toBe(true);
  });

  it("rejects non-objects and wrong service markers", () => {
    expect(isProtectionStatsOk(undefined)).toBe(false);
    expect(isProtectionStatsOk(null)).toBe(false);
    expect(isProtectionStatsOk("ficta")).toBe(false);
    expect(isProtectionStatsOk({ ...validPayload(), ok: false })).toBe(false);
    expect(isProtectionStatsOk({ ...validPayload(), service: "other" })).toBe(false);
  });

  it("rejects missing or mistyped totals", () => {
    const missing = validPayload();
    delete (missing.stats.totals as Record<string, unknown>).withheldFromToolsValues;
    expect(isProtectionStatsOk(missing)).toBe(false);

    const mistyped = validPayload();
    (mistyped.stats.totals as Record<string, unknown>).events = "1";
    expect(isProtectionStatsOk(mistyped)).toBe(false);
  });

  it("rejects missing or mistyped event fields", () => {
    const badSurface = validPayload();
    (badSurface.stats.events[0] as Record<string, unknown>).surface = "headers";
    expect(isProtectionStatsOk(badSurface)).toBe(false);

    const badHit = validPayload();
    (badHit.stats.events[0]?.redactedHits[0] as Record<string, unknown>).confidence = "medium";
    expect(isProtectionStatsOk(badHit)).toBe(false);

    const badBlocked = validPayload();
    (badBlocked.stats.events[0] as Record<string, unknown>).blocked = "false";
    expect(isProtectionStatsOk(badBlocked)).toBe(false);
  });
});
