import { type EnvSource, envFlag } from "./env-flags.js";

/**
 * Core-owned fail-closed policy for detector outages. A detector only *signals* that its backend
 * could not run (throwing `DetectorUnavailableError`) and *exposes* its own `failClosed()` override;
 * this module decides whether an outage blocks the request.
 *
 * Resolution is `perPluginOverride ?? globalDefault`: the per-detector setting (e.g. `[pii]
 * fail_closed`) wins when set, otherwise the engine's `detection.failClosed` (env
 * `FICTA_FAIL_CLOSED_DETECTION`, default off) applies. This is separate from `FICTA_FAIL_CLOSED`, which
 * blocks on *registered-secret* leaks — a different condition with a different (on) default.
 */

/** Parse the global default from env-style settings (`FICTA_FAIL_CLOSED_DETECTION`). Default false. */
export function globalDetectionFailClosed(env: EnvSource): boolean {
  return envFlag(env.FICTA_FAIL_CLOSED_DETECTION);
}

/** Effective policy for one detector: its override if set, else the engine's global default. */
export function detectorFailClosed(override: boolean | undefined, globalDefault: boolean): boolean {
  return override ?? globalDefault;
}
