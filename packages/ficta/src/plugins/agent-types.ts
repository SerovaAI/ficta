import type { FictaPluginBase } from "../engine/plugins/types.js";

// Agent-launch types. These are a product concern (how the CLI launches Claude/Codex/Pi through
// ficta) and are deliberately kept out of the engine's type surface — the engine never launches
// agents, and an agent-integration plugin contributes nothing to redaction.

export interface AgentBypassContext {
  /** User-supplied args after the agent command and ficta-only flags were removed. */
  args: string[];
  /** Real executable resolved outside ~/.ficta/bin. */
  realExecutable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface AgentLaunchContext extends AgentBypassContext {
  /** Base ficta proxy URL, no trailing slash, e.g. http://127.0.0.1:8787. */
  baseUrl: string;
}

export interface AgentLaunchPlan {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Remove temporary config/extension files after the agent exits. */
  cleanup?: () => void | Promise<void>;
}

/** How to launch one AI coding client through ficta. */
export interface AgentIntegration {
  /** Stable id, e.g. builtin/claude. */
  id: string;
  /** Executable/shim command, e.g. claude, codex, pi. */
  command: string;
  label: string;
  description?: string;
  /** Return true for commands that do not call a model (e.g. --version, package management). */
  shouldBypass?(args: readonly string[]): boolean;
  /** Return true when the invocation is intended for machine-readable output, so diagnostics stay quiet by default. */
  isMachineReadable?(args: readonly string[]): boolean;
  /** Launch through ficta. */
  configureLaunch(ctx: AgentLaunchContext): AgentLaunchPlan;
  /** Optional dynamic cleanup for FICTA_DISABLE=1 bypasses, e.g. neutralizing stale persisted config. */
  configureBypass?(ctx: AgentBypassContext): AgentLaunchPlan;
}

export interface AgentIntegrationPlugin extends FictaPluginBase {
  kind: "agent-integration";
  agents: readonly AgentIntegration[];
  config?: never;
  setup?: never;
  discover?: never;
  loadValues?: never;
  detectText?: never;
}
