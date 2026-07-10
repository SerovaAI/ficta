import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_PROTECTION_TICKET_HEADER,
  FICTA_REGISTRY_REVISION_HEADER,
  FICTA_SCOPE_HEADER,
  FICTA_TRACE_CAPTURE_HEADER,
  isProtectionPreviewOk,
  isProtectionStatsOk,
  isProxyConfigOk,
  isRegistryReloadOk,
  normalizePiiBackends,
  normalizeRestoreIntoToolsPolicy,
} from "../src/index.js";

function statsPayload() {
  return {
    ok: true,
    service: "ficta",
    stats: {
      version: 1,
      path: "/tmp/ficta/protection-stats.json",
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

function configPayload() {
  return {
    ok: true,
    service: "ficta",
    config: {
      protection: {
        failClosed: true,
        requireRegistry: false,
        globallyDisabled: false,
        redactPaths: false,
        restoreIntoTools: "detected",
        surrogateStyle: "opaque",
      },
      detection: {
        pii: {
          standalone: true,
          agents: false,
          configuredBackend: "regex",
          configuredBackends: ["regex"],
          failureMode: "fail-open",
        },
        secretShapes: { standalone: false, agents: false },
      },
      transport: {
        host: "127.0.0.1",
        port: 8787,
        upstreams: {
          anthropic: "https://api.anthropic.com",
          openai: "https://api.openai.com",
          chatgpt: "https://chatgpt.com",
        },
        allowCustomUpstream: false,
        logLevel: "info",
        logBodies: false,
        traceAudit: false,
        logDir: "/home/user/.ficta/logs",
      },
    },
    edit: {
      path: "/home/user/.ficta/config.toml",
      disabled: false,
      restartRequired: false,
      values: {
        failClosed: true,
        piiEnabled: true,
        piiBackends: ["regex"],
        piiFailClosed: false,
        piiPresidioUrl: "http://127.0.0.1:5002",
        piiOpenmedUrl: "http://127.0.0.1:5004",
        secretShapesEnabled: false,
        surrogateStyle: "opaque",
        restoreIntoTools: "detected",
        allowCustomUpstream: false,
      },
      locked: {},
    },
  };
}

function bucket(name) {
  return {
    name,
    requests: 1,
    redactedValues: 1,
    survivingValues: 0,
    blockedRequests: 0,
    keptOutOfModelValues: 1,
  };
}

describe("protocol constants", () => {
  it("exports the shared scope header", () => {
    assert.equal(FICTA_SCOPE_HEADER, "x-ficta-scope");
  });

  it("exports the shared trace capture header", () => {
    assert.equal(FICTA_TRACE_CAPTURE_HEADER, "x-ficta-trace-capture");
  });

  it("exports the registry revision acknowledgement header", () => {
    assert.equal(FICTA_REGISTRY_REVISION_HEADER, "x-ficta-registry-revision");
  });

  it("exports the protection preview path and ticket header", () => {
    assert.equal(FICTA_PROTECTION_PREVIEW_PATH, "/__ficta/protection-preview");
    assert.equal(FICTA_PROTECTION_TICKET_HEADER, "x-ficta-protection-ticket");
  });
});

describe("normalizers", () => {
  it("normalizes PII backends and restore-into-tools policies", () => {
    assert.deepEqual(normalizePiiBackends(["regex", "regex", "openmed"]), ["regex", "openmed"]);
    assert.deepEqual(normalizePiiBackends([]), ["regex"]);
    assert.equal(normalizePiiBackends(["other"]), undefined);
    assert.equal(normalizeRestoreIntoToolsPolicy("detected"), "detected");
    assert.equal(normalizeRestoreIntoToolsPolicy(true), "all");
    assert.equal(normalizeRestoreIntoToolsPolicy(false), "none");
  });
});

describe("runtime guards", () => {
  it("accepts valid config and protection-stats payloads", () => {
    assert.equal(isProxyConfigOk(configPayload()), true);
    assert.equal(isProtectionStatsOk(statsPayload()), true);
  });

  it("rejects malformed config and protection-stats payloads", () => {
    const badConfig = configPayload();
    badConfig.config.transport.traceAudit = "false";
    assert.equal(isProxyConfigOk(badConfig), false);

    const badStats = statsPayload();
    badStats.stats.events[0].surface = "headers";
    assert.equal(isProtectionStatsOk(badStats), false);
  });

  it("validates revision-aware registry reload payloads", () => {
    assert.equal(
      isRegistryReloadOk({
        ok: true,
        service: "ficta",
        registry: {
          added: 1,
          total: 12,
          loaded: 10,
          skippedTooShort: 2,
          filesRead: 1,
          filesMissing: 0,
          filesErrored: 0,
          revision: "8fe0f1e0-4e6c-4627-afcb-4628993ad0af",
        },
      }),
      true,
    );
    assert.equal(isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: -1, total: 12 } }), false);
    assert.equal(
      isRegistryReloadOk({ ok: true, service: "ficta", registry: { added: 0, total: 12, filesErrored: 0.5 } }),
      false,
    );
  });

  it("validates protection previews", () => {
    const preview = {
      ok: true,
      service: "ficta",
      ticket: "ticket-1",
      textSha256: "a".repeat(64),
      redactedText: "Contact FICTA_0123456789abcdef0123456789abcdef",
      findings: [
        {
          start: 8,
          end: 25,
          surrogate: "FICTA_0123456789abcdef0123456789abcdef",
          origin: "detected",
          name: "EMAIL",
          source: "pii-regex",
          kind: "pii",
          confidence: "high",
        },
      ],
    };
    assert.equal(isProtectionPreviewOk(preview), true);
    preview.findings[0].end = 7;
    assert.equal(isProtectionPreviewOk(preview), false);
  });
});
