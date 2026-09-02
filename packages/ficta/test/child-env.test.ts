import { describe, expect, it } from "vitest";
import { sanitizeAgentEnv } from "../src/child-env.js";

describe("child agent environment", () => {
  it("does not pass the local surrogate key to child agents", () => {
    const env = sanitizeAgentEnv({
      FICTA_SURROGATE_KEY: "local-proxy-secret",
      ANTHROPIC_API_KEY: "provider-auth-still-needed",
      PATH: "/usr/bin",
    });

    expect(env.FICTA_SURROGATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("provider-auth-still-needed");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops FICTA_* settings the launcher merged in from config.toml, defaults, or per-launch resolution", () => {
    const shell = { PATH: "/usr/bin", FICTA_SHIM_AGENT: "claude", FICTA_SHIM_DIR: "/home/u/.ficta/bin" };
    const merged = {
      ...shell,
      // config.toml → env (loadUserConfig), plus the agent-launch gate forced by cli.ts
      FICTA_PII_ENABLED: "1",
      FICTA_PII_AGENTS: "0",
      FICTA_PII_FAIL_CLOSED: "1",
      FICTA_PII_PRESIDIO_URL: "http://127.0.0.1:5002",
      FICTA_SECRET_SHAPES_ENABLED: "1",
      FICTA_FAIL_CLOSED: "1",
      FICTA_LOG_ROLE: "agents/claude/2026-09-02T06-21-21-508Z-79975",
      FICTA_LOG_LEVEL: "silent",
      FICTA_ALLOW_EMPTY: "1",
      FICTA_SURROGATE_KEY: "local-proxy-secret",
    };

    const env = sanitizeAgentEnv(merged, shell);

    expect(env).toEqual(shell);
  });

  it("keeps explicit shell FICTA_* overrides, restoring the value the shell set", () => {
    const shell = { FICTA_PII_ENABLED: "maybe", FICTA_LOG_LEVEL: "debug", FICTA_SURROGATE_KEY: "shell-secret" };
    // cli.ts rewrites the unparseable shell value to the resolved gate; the child gets the shell's own.
    const merged = { ...shell, FICTA_PII_ENABLED: "0", FICTA_PII_AGENTS: "0" };

    const env = sanitizeAgentEnv(merged, shell);

    expect(env.FICTA_PII_ENABLED).toBe("maybe");
    expect(env.FICTA_LOG_LEVEL).toBe("debug");
    expect(env.FICTA_PII_AGENTS).toBeUndefined();
    expect(env.FICTA_SURROGATE_KEY).toBeUndefined(); // denylisted even when the shell set it
  });

  it("leaves non-FICTA variables untouched even when the launcher changed them", () => {
    const shell = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
    const merged = { ANTHROPIC_BASE_URL: "http://127.0.0.1:50027", NODE_OPTIONS: "--x" };

    expect(sanitizeAgentEnv(merged, shell)).toEqual(merged);
  });
});
