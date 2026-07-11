import type { ProxyConfigPosture } from "@serovaai/ficta-protocol";
import type { Config } from "./config.js";
import { detectorFailClosed } from "./engine/detection-policy.js";
import { envFlag, restoreIntoToolsPolicy } from "./engine/env-flags.js";
import { surrogateStyle } from "./engine/surrogate.js";
import { isGloballyDisabled } from "./global-disable.js";
import {
  piiEnabled,
  piiFailClosed,
  resolveAgentPiiEnabled,
  resolveAgentSecretShapesEnabled,
  secretShapesEnabled,
  selectedBackendNames,
} from "./plugins/index.js";

export type ConfigPosture = ProxyConfigPosture;

/**
 * Build the posture from the transport `Config` plus the engine-side env flags. The engine has no
 * typed config object — plugins read `process.env` at request time — so the env dependency is an
 * explicit parameter here rather than a hidden ambient read; tests pass a plain object.
 * `globallyDisabled` is a filesystem check (~/.ficta/disabled), injectable for the same reason.
 * `host`/`port` are the configured bind values; a port-0 bind can differ from the actual port.
 */
export function configPosture(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    globallyDisabled?: boolean;
    traceCapture?: ProxyConfigPosture["transport"]["traceCapture"];
  } = {},
): ConfigPosture {
  return {
    protection: {
      failClosed: cfg.failClosed,
      requireRegistry: env.FICTA_REQUIRE_REGISTRY === "1",
      globallyDisabled: opts.globallyDisabled ?? isGloballyDisabled(),
      redactPaths: envFlag(env.FICTA_REDACT_PATHS),
      restoreIntoTools: restoreIntoToolsPolicy(env.FICTA_RESTORE_INTO_TOOLS),
      surrogateStyle: surrogateStyle(env),
    },
    detection: {
      pii: {
        standalone: piiEnabled(env),
        // Posture, not a per-run override, so the agent gate is evaluated with no shell value.
        agents: resolveAgentPiiEnabled({ enabled: env.FICTA_PII_ENABLED, agents: env.FICTA_PII_AGENTS }),
        configuredBackends: selectedBackendNames(env),
        configuredBackend: selectedBackendNames(env).join(","),
        failureMode: detectorFailClosed(piiFailClosed(env), env) ? "fail-closed" : "fail-open",
      },
      secretShapes: {
        standalone: secretShapesEnabled(env),
        agents: resolveAgentSecretShapesEnabled({
          enabled: env.FICTA_SECRET_SHAPES_ENABLED,
          agents: env.FICTA_SECRET_SHAPES_AGENTS,
        }),
      },
    },
    transport: {
      host: cfg.host,
      port: cfg.port,
      upstreams: {
        anthropic: stripUserinfo(cfg.upstreams.anthropic),
        openai: stripUserinfo(cfg.upstreams.openai),
        chatgpt: stripUserinfo(cfg.upstreams.chatgpt),
      },
      forcedUpstream: cfg.forcedUpstream === undefined ? undefined : stripUserinfo(cfg.forcedUpstream),
      allowCustomUpstream: cfg.allowCustomUpstream,
      logLevel: cfg.logLevel,
      logBodies: opts.traceCapture?.enabled ?? false,
      traceAudit: cfg.traceAudit,
      traceCapture: opts.traceCapture ?? { enabled: false },
      logDir: cfg.logDir,
    },
  };
}

// Upstream URLs are operator-supplied and may carry basic-auth userinfo; the posture is values-free,
// so credentials never leave in it. Only rewrite when userinfo is present — URL.toString() would
// otherwise normalize innocent values (e.g. add a trailing slash).
function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
