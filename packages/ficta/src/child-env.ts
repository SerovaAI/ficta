const INTERNAL_CHILD_ENV_DENYLIST = new Set([
  // Used only by the local proxy to derive/restore surrogates. The coding agent never needs it,
  // and if the agent prints its environment this value could otherwise be sent to the model.
  "FICTA_SURROGATE_KEY",
]);

const FICTA_ENV_PREFIX = "FICTA_";

/**
 * Environment passed to child agents. Keeps normal auth/config, drops proxy-internal secrets.
 *
 * `shellEnv` is the environment as the launcher found it, captured before `loadUserConfig()` and
 * `applyRuntimeEnvDefaults()` merged config.toml, built-in defaults, and per-launch resolutions
 * (the agent PII/secret-shapes gates, `FICTA_LOG_ROLE`, `--allow-empty`) into `process.env`. Every
 * `FICTA_*` key the child sees is restored to that shell value, and keys the launcher introduced are
 * dropped. The agent itself reads none of them; what matters is a *nested* launch — `claude` started
 * from a tool call, a subshell, or a `FICTA_DISABLE=1` session — which treats an inherited
 * `FICTA_PII_ENABLED=1` as an explicit shell override, ignores `pii.agents = false`, and then needs
 * the Presidio sidecar to be up for every request. Nested launches must re-resolve from config
 * exactly like a fresh shell would.
 */
export function sanitizeAgentEnv(env: NodeJS.ProcessEnv, shellEnv: NodeJS.ProcessEnv = env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (!key.startsWith(FICTA_ENV_PREFIX)) continue;
    const shellValue = shellEnv[key];
    if (shellValue === undefined) delete out[key];
    else out[key] = shellValue;
  }
  for (const key of INTERNAL_CHILD_ENV_DENYLIST) delete out[key];
  return out;
}
