import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { configPosture } from "../src/config-posture.js";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreams: {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
      chatgpt: "https://chatgpt.com",
    },
    forcedUpstream: undefined,
    allowCustomUpstream: false,
    logDir: "/tmp/ficta-logs",
    logLevel: "info",
    logBodies: false,
    logMaxBytes: 256 * 1024,
    failClosed: true,
    ...overrides,
  };
}

// The env dependency is an explicit parameter, so these tests pass plain objects instead of
// mutating process.env; globallyDisabled is injected so the dev machine's ~/.ficta state is inert.
describe("configPosture", () => {
  it("reports the default posture from an empty env", () => {
    const posture = configPosture(cfg(), {}, { globallyDisabled: false });

    expect(posture).toEqual({
      protection: {
        failClosed: true,
        requireRegistry: false,
        globallyDisabled: false,
        redactPaths: false,
        restoreIntoTools: false,
        surrogateStyle: "opaque",
      },
      detection: {
        pii: { standalone: false, agents: false, configuredBackend: "regex", failureMode: "fail-open" },
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
        forcedUpstream: undefined,
        allowCustomUpstream: false,
        logLevel: "info",
        logBodies: false,
        logDir: "/tmp/ficta-logs",
      },
    });
  });

  it("reflects flipped env flags and cfg overrides", () => {
    const posture = configPosture(
      cfg({ failClosed: false, allowCustomUpstream: true, logLevel: "trace", logBodies: true }),
      {
        FICTA_REQUIRE_REGISTRY: "1",
        FICTA_REDACT_PATHS: "1",
        FICTA_RESTORE_INTO_TOOLS: "1",
        FICTA_SURROGATE_STYLE: "typed",
        FICTA_PII_ENABLED: "1",
        FICTA_PII_AGENTS: "1",
        FICTA_PII_BACKEND: "presidio",
        FICTA_PII_FAIL_CLOSED: "1",
        FICTA_SECRET_SHAPES_ENABLED: "1",
      },
      { globallyDisabled: true },
    );

    expect(posture.protection).toEqual({
      failClosed: false,
      requireRegistry: true,
      globallyDisabled: true,
      redactPaths: true,
      restoreIntoTools: true,
      surrogateStyle: "typed",
    });
    expect(posture.detection.pii).toEqual({
      standalone: true,
      agents: true,
      configuredBackend: "presidio",
      failureMode: "fail-closed",
    });
    expect(posture.detection.secretShapes).toEqual({ standalone: true, agents: false });
    expect(posture.transport.allowCustomUpstream).toBe(true);
    expect(posture.transport.logLevel).toBe("trace");
    expect(posture.transport.logBodies).toBe(true);
  });

  it("gates agent detection on both enabled and agents flags", () => {
    const posture = configPosture(
      cfg(),
      { FICTA_PII_AGENTS: "1", FICTA_SECRET_SHAPES_AGENTS: "1" },
      {
        globallyDisabled: false,
      },
    );
    // agents=1 with enabled unset is a no-op — `enabled` stays the single kill switch.
    expect(posture.detection.pii).toMatchObject({ standalone: false, agents: false });
    expect(posture.detection.secretShapes).toEqual({ standalone: false, agents: false });
  });

  it("strips userinfo from upstream URLs and leaves plain URLs verbatim", () => {
    const posture = configPosture(
      cfg({
        upstreams: {
          anthropic: "https://user:hunter2@upstream.example/base",
          openai: "https://api.openai.com",
          chatgpt: "https://chatgpt.com",
        },
        forcedUpstream: "https://token:sekret@forced.example",
      }),
      {},
      { globallyDisabled: false },
    );

    expect(posture.transport.upstreams.anthropic).not.toContain("hunter2");
    expect(posture.transport.upstreams.anthropic).toContain("upstream.example");
    expect(posture.transport.forcedUpstream).not.toContain("sekret");
    // No userinfo → returned byte-for-byte (URL.toString() would add a trailing slash).
    expect(posture.transport.upstreams.openai).toBe("https://api.openai.com");
    expect(posture.transport.upstreams.chatgpt).toBe("https://chatgpt.com");
    expect(JSON.stringify(posture)).not.toMatch(/hunter2|sekret/);
  });
});
