import { accessSync, constants, existsSync } from "node:fs";
import { configuredUpstreamPolicyIssues, loadConfig } from "./config.js";
import { configPosture } from "./config-posture.js";
import { applyRuntimeEnvDefaults } from "./defaults.js";
import { detectorFailClosed } from "./engine/detection-policy.js";
import type { RestoreIntoToolsPolicy } from "./engine/env-flags.js";
import { globalDisablePath, isGloballyDisabled } from "./global-disable.js";
import { defaultShimDir, findExecutable } from "./install.js";
import type { LogLevel } from "./log-level.js";
import { codexUsesChatgptAuth } from "./plugins/agents.js";
import {
  type AgentIntegration,
  activeBackends,
  agentIntegrations,
  backendHealthCheck,
  loadPluginRegistry,
  type PluginDiscovery,
  parseUserExclusionRule,
  piiEnabled,
  piiFailClosed,
  type RegistryPolicy,
  registryDiscoveryLines,
  registryPolicyLines,
} from "./plugins/index.js";
import { configPath } from "./user-config.js";

export interface DoctorOptions {
  /** Optional agent command to check strictly, e.g. claude/codex/pi. */
  agent?: string;
}

export interface DoctorReport {
  config: {
    configPath?: string;
    configExists: boolean;
    failClosed: boolean;
    logLevel: LogLevel;
    logBodies: boolean;
    traceAudit: boolean;
    redactPaths: boolean;
    requireRegistry: boolean;
    globallyDisabled: boolean;
    disablePath: string;
    /** PII detection posture for the web/standalone proxy (governed by [pii] enabled). */
    piiStandalone: boolean;
    /** PII detection posture for launched coding agents (needs [pii] enabled AND [pii] agents). */
    piiAgents: boolean;
    /** Secret-shape detection posture for the web/standalone proxy (governed by [secret_shapes] enabled). */
    secretShapesStandalone: boolean;
    /** Secret-shape detection posture for launched coding agents (needs [secret_shapes] enabled AND [secret_shapes] agents). */
    secretShapesAgents: boolean;
    /** Active surrogate token style (governed by [surrogate] style / FICTA_SURROGATE_STYLE). */
    surrogateStyle: "opaque" | "typed";
    /** Restore-into-tools policy (FICTA_RESTORE_INTO_TOOLS; default `detected`). */
    restoreIntoTools: RestoreIntoToolsPolicy;
    upstreams: { anthropic: string; openai: string; chatgpt: string };
    forcedUpstream?: string;
    allowCustomUpstream: boolean;
  };
  registry: {
    protectedValues: number;
    discoveries: PluginDiscovery[];
    policy: RegistryPolicy;
    policyExcludedBySource: Record<string, number>;
  };
  agents: DoctorAgentReport[];
  issues: DoctorIssue[];
}

interface DoctorAgentReport {
  command: string;
  label: string;
  selected: boolean;
  executable?: string;
  overrideEnv?: string;
  executableUsable?: boolean;
  route: string;
  status: "ok" | "warning" | "error";
  message: string;
}

interface DoctorIssue {
  severity: "warning" | "error";
  message: string;
}

export async function collectDoctorReport(opts: DoctorOptions = {}): Promise<DoctorReport> {
  applyRuntimeEnvDefaults(process.env);

  const cfg = loadConfig();
  const globallyDisabled = isGloballyDisabled();
  const registry = loadPluginRegistry();
  const integrations = agentIntegrations();
  const selected = opts.agent ? integrations.find((agent) => agent.command === opts.agent) : undefined;
  const unknownAgent = Boolean(opts.agent && !selected);
  const agentsToCheck = selected ? [selected] : integrations;
  const issues: DoctorIssue[] = [];

  if (unknownAgent) issues.push({ severity: "error", message: `unknown agent: ${opts.agent}` });

  if (registry.values.length === 0) {
    issues.push({
      severity: process.env.FICTA_REQUIRE_REGISTRY === "1" ? "error" : "warning",
      message:
        process.env.FICTA_REQUIRE_REGISTRY === "1"
          ? "no protected values loaded; FICTA_REQUIRE_REGISTRY=1 blocks provider requests and agent launch"
          : "no protected values loaded; ficta would launch in passthrough mode",
    });
  }

  if (process.env.FICTA_REQUIRE_REGISTRY === "1") {
    for (const discovery of registry.discoveries) {
      if (discovery.status === "error") {
        issues.push({
          severity: "error",
          message: `registry source ${discovery.label} reported an error in strict mode`,
        });
      }
    }
  }

  if (globallyDisabled) {
    issues.push({ severity: "warning", message: "ficta is globally disabled; run `ficta enable` to re-enable shims" });
  }

  if (!cfg.failClosed) {
    issues.push({ severity: "warning", message: "FICTA_FAIL_CLOSED=0 is set; leaks would be warned, not blocked" });
  }
  for (const upstreamIssue of configuredUpstreamPolicyIssues(cfg)) {
    issues.push({ severity: "error", message: upstreamIssue });
  }
  if (cfg.traceAudit) {
    issues.push({
      severity: "warning",
      message: "FICTA_TRACE_AUDIT=1 is set; raw protected values may be written to audit sidecars",
    });
  }
  const path = configPath();
  if (!process.env.FICTA_SURROGATE_KEY) {
    issues.push({
      severity: "warning",
      message: path
        ? "no stable surrogate key is active yet; normal launch/install will generate one in ~/.ficta/config.toml"
        : "no stable surrogate key is active; FICTA_CONFIG_FILE=0 means launches use per-process surrogates unless FICTA_SURROGATE_KEY is set",
    });
  }

  const { invalidNames } = parseUserExclusionRule(process.env.FICTA_REGISTRY_EXCLUDE_NAMES);
  if (invalidNames.length > 0) {
    issues.push({
      severity: "warning",
      message: `registry.exclude_names has invalid entries (ignored): ${invalidNames.join(", ")}`,
    });
  }

  if (piiEnabled()) {
    const { backends, unknown } = activeBackends();
    for (const name of unknown) {
      issues.push({
        severity: "warning",
        message: `unknown PII backend "${name}" configured — skipping it`,
      });
    }
    for (const { name } of backends) {
      const probe = backendHealthCheck(name);
      if (!probe) continue;
      const health = await probe();
      if (!health.ok) {
        const consequence = detectorFailClosed(piiFailClosed())
          ? "requests will be BLOCKED (503) until it is reachable (fail-closed)"
          : "that backend is skipped while reachable backends still run (fail-open)";
        issues.push({
          severity: "warning",
          message: `PII backend "${name}" is selected but ${health.url} is unreachable${
            health.detail ? ` (${health.detail})` : ""
          } — ${consequence}`,
        });
      }
    }
  }

  const agentReports = agentsToCheck.map((agent) => doctorAgentReport(agent, Boolean(selected)));
  for (const agent of agentReports) {
    if (agent.status === "error") issues.push({ severity: "error", message: `${agent.command}: ${agent.message}` });
  }

  // Same posture object `GET /__ficta/config` serializes, flattened into the report's existing
  // shape — one source of truth, so doctor and the endpoint cannot drift.
  const posture = configPosture(cfg, process.env, { globallyDisabled });

  return {
    config: {
      configPath: path,
      configExists: Boolean(path && existsSync(path)),
      failClosed: posture.protection.failClosed,
      logLevel: posture.transport.logLevel,
      logBodies: posture.transport.logBodies,
      traceAudit: cfg.traceAudit,
      redactPaths: posture.protection.redactPaths,
      requireRegistry: posture.protection.requireRegistry,
      globallyDisabled,
      disablePath: globalDisablePath(),
      piiStandalone: posture.detection.pii.standalone,
      piiAgents: posture.detection.pii.agents,
      secretShapesStandalone: posture.detection.secretShapes.standalone,
      secretShapesAgents: posture.detection.secretShapes.agents,
      surrogateStyle: posture.protection.surrogateStyle,
      restoreIntoTools: posture.protection.restoreIntoTools,
      upstreams: posture.transport.upstreams,
      forcedUpstream: posture.transport.forcedUpstream,
      allowCustomUpstream: posture.transport.allowCustomUpstream,
    },
    registry: {
      protectedValues: registry.values.length,
      discoveries: registry.discoveries,
      policy: registry.registryPolicy,
      policyExcludedBySource: registry.policyExcludedBySource,
    },
    agents: agentReports,
    issues,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("ficta doctor");
  lines.push("");

  lines.push("config");
  if (report.config.configPath) {
    lines.push(
      `  ${report.config.configExists ? "✓" : "-"} user config: ${report.config.configPath}${
        report.config.configExists ? "" : " (not found; defaults/env in use)"
      }`,
    );
  } else {
    lines.push("  - user config: disabled by FICTA_CONFIG_FILE=0");
  }
  lines.push(`  ${report.config.failClosed ? "✓" : "!"} fail-closed: ${report.config.failClosed ? "on" : "OFF"}`);
  lines.push(`  - log level: ${report.config.logLevel}`);
  lines.push("  ✓ raw body logs: off (runtime admin control)");
  lines.push(`  ${report.config.traceAudit ? "!" : "✓"} raw value audit: ${report.config.traceAudit ? "ON" : "off"}`);
  lines.push(
    `  ${report.config.redactPaths ? "!" : "-"} path-like tokens: ${
      report.config.redactPaths ? "redacted on all surfaces" : "redacted in headers, preserved in body/query"
    }`,
  );
  lines.push(
    `  ${report.config.requireRegistry ? "!" : "-"} require registry: ${report.config.requireRegistry ? "on" : "off"}`,
  );
  lines.push(
    `  ${report.config.globallyDisabled ? "!" : "✓"} global disable: ${
      report.config.globallyDisabled ? `ON (${report.config.disablePath})` : "off"
    }`,
  );
  lines.push(
    `  ${report.config.piiStandalone || report.config.piiAgents ? "!" : "-"} pii detection: standalone/web ${
      report.config.piiStandalone ? "on" : "off"
    }; agent launches ${report.config.piiAgents ? "on" : "off"} (pii.agents)`,
  );
  lines.push(
    `  ${
      report.config.secretShapesStandalone || report.config.secretShapesAgents ? "!" : "-"
    } secret-shape detection: standalone/web ${
      report.config.secretShapesStandalone ? "on" : "off"
    }; agent launches ${report.config.secretShapesAgents ? "on" : "off"} (secret_shapes.agents)`,
  );
  lines.push(
    `  - surrogate style: ${
      report.config.surrogateStyle === "typed" ? "typed (FICTA_<TYPE>_… tokens)" : "opaque (FICTA_… tokens)"
    }`,
  );
  lines.push(restoreIntoToolsLine(report.config.restoreIntoTools));
  lines.push("");

  lines.push("registry");
  lines.push(
    `  ${report.registry.protectedValues > 0 ? "✓" : "!"} protected values loaded: ${report.registry.protectedValues}`,
  );
  for (const line of registryDiscoveryLines(
    report.registry.discoveries,
    "  ",
    report.registry.policyExcludedBySource,
  )) {
    lines.push(line);
  }
  const policyLines = registryPolicyLines(report.registry.policy, "  ");
  if (policyLines.length > 0) {
    lines.push("  registry policy exclusions:");
    for (const line of policyLines) lines.push(line);
  }
  lines.push("");

  lines.push("agents");
  if (report.agents.length === 0) {
    lines.push("  ! no built-in agent integration matched");
  } else {
    for (const agent of report.agents) {
      const icon = agent.status === "ok" ? "✓" : agent.status === "error" ? "✗" : "!";
      lines.push(`  ${icon} ${agent.command} (${agent.label}): ${agent.message}`);
      lines.push(`      route: ${agent.route}`);
      if (agent.executable)
        lines.push(`      executable: ${agent.executable}${agent.overrideEnv ? ` (${agent.overrideEnv})` : ""}`);
    }
  }
  lines.push("");

  lines.push("upstreams");
  if (report.config.forcedUpstream) lines.push(`  ! forced upstream: ${report.config.forcedUpstream}`);
  if (report.config.allowCustomUpstream) lines.push("  ! custom upstreams: allowed by FICTA_ALLOW_CUSTOM_UPSTREAM=1");
  lines.push(`  anthropic: ${report.config.upstreams.anthropic}`);
  lines.push(`  openai:    ${report.config.upstreams.openai}`);
  lines.push(`  chatgpt:   ${report.config.upstreams.chatgpt}`);
  lines.push("");

  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  lines.push("summary");
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("  ✓ no issues found");
  } else {
    for (const issue of errors) lines.push(`  ✗ ${issue.message}`);
    for (const issue of warnings) lines.push(`  ! ${issue.message}`);
  }

  return `${lines.join("\n")}\n`;
}

export function doctorExitCode(report: DoctorReport): number {
  return report.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

function restoreIntoToolsLine(policy: RestoreIntoToolsPolicy): string {
  switch (policy) {
    case "all":
      return "  ! restore into tools: all — tool-call arguments receive REAL values, registry secrets included (FICTA_RESTORE_INTO_TOOLS=all)";
    case "none":
      return "  - restore into tools: none — every tool-call argument keeps placeholder surrogates (FICTA_RESTORE_INTO_TOOLS=none)";
    case "detected":
      return "  - restore into tools: detected — locally-read content restored into tool-call arguments; registry secrets kept as placeholders (default)";
  }
}

function doctorAgentReport(agent: AgentIntegration, selected: boolean): DoctorAgentReport {
  const overrideEnv = realAgentEnvName(agent.command);
  const override = process.env[overrideEnv];
  const executable = override || findExecutable(agent.command, { excludeDirs: shimDirs() });
  const executableUsable = executable ? isUsableExecutable(executable) : false;
  const route = routeSummary(agent.command);

  if (!executable) {
    return {
      command: agent.command,
      label: agent.label,
      selected,
      route,
      status: selected ? "error" : "warning",
      message: selected
        ? `real executable not found outside ${shimDirs().join(", ")}`
        : `not installed or not found outside ${shimDirs().join(", ")}`,
    };
  }

  if (override && !executableUsable) {
    return {
      command: agent.command,
      label: agent.label,
      selected,
      executable,
      overrideEnv,
      executableUsable,
      route,
      status: selected ? "error" : "warning",
      message: `${overrideEnv} is set but is not executable/readable`,
    };
  }

  return {
    command: agent.command,
    label: agent.label,
    selected,
    executable,
    overrideEnv: override ? overrideEnv : undefined,
    executableUsable,
    route,
    status: "ok",
    message: override ? `using ${overrideEnv}` : "found real executable",
  };
}

function realAgentEnvName(command: string): string {
  return `FICTA_REAL_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function shimDirs(): string[] {
  return [defaultShimDir(), process.env.FICTA_SHIM_DIR].filter((v): v is string => Boolean(v));
}

function routeSummary(command: string): string {
  if (command === "claude") return "sets ANTHROPIC_BASE_URL to the ephemeral ficta proxy";
  if (command === "codex") {
    return codexUsesChatgptAuth(process.env)
      ? "injects Codex custom provider + chatgpt_base_url (ChatGPT/OAuth detected)"
      : "injects Codex custom provider for OpenAI-compatible traffic";
  }
  if (command === "pi") return "routes Pi via an ephemeral PI_CODING_AGENT_DIR with a models.json base-URL override";
  return "agent integration supplies launch environment";
}

function isUsableExecutable(path: string): boolean {
  // If the override is a bare command name, spawn will resolve it through PATH at launch time.
  if (!path.includes("/")) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
