import type { EngineConfig } from "../../config.js";
import { compareCategoryClaims } from "../../detection-priority.js";
import { detectorFailClosed } from "../../detection-policy.js";
import { type EnvSource, envFlag, parseBoolean } from "../../env-flags.js";
import { expansionSpans } from "../../expander.js";
import { DetectorUnavailableError } from "../../redaction-engine.js";
import type { DetectorPlugin, PluginDiscovery, PluginRuntime, ProtectedValue } from "../types.js";
import { type MarkdownDetectionView, normalizeMarkdownForDetection } from "./markdown.js";
import { OpenmedUnavailableError } from "./openmed-recognizer.js";
import { PresidioUnavailableError, withMergedSpans } from "./presidio-recognizer.js";
import { REGEX_FLOOR_SOURCE } from "./regex-recognizer.js";
import { ENV_BACKEND, ENV_BACKENDS, resolveBackends } from "./registry.js";

const PLUGIN_NAME = "pii";
const ENV_ENABLED = "FICTA_PII_ENABLED";
const ENV_AGENTS = "FICTA_PII_AGENTS";
const ENV_FAIL_CLOSED = "FICTA_PII_FAIL_CLOSED";

/**
 * PII detection can run one or more configured backends — `FICTA_PII_BACKENDS` ↔ `[pii] backends`.
 * The legacy single-backend setting (`FICTA_PII_BACKEND` / `[pii] backend`) remains supported when
 * `backends` is unset. Each backend plugs in behind {@link import("./recognizer.js").PiiRecognizer}.
 * The plugin coordinates backend calls, records per-backend outages, and merges detected values so
 * combinations like `presidio,openmed` can keep their containers separate while sharing one Ficta
 * detector policy.
 */

/**
 * Parse the PII enable flag from env-style settings. The engine itself reads `pii.enabled` from its
 * config; this is for the host's config adapter and `ficta doctor`.
 */
export function piiEnabled(env: EnvSource): boolean {
  return envFlag(env[ENV_ENABLED]);
}

/**
 * The user's per-detector fail-closed *override* (`[pii] fail_closed`), exposed for the core resolver
 * and `ficta doctor`. Tri-state: `true`/`false` force the policy, `undefined` (unset) defers to the
 * global `FICTA_FAIL_CLOSED_DETECTION` default. This only reports config — the core enforces it.
 * Independent of `FICTA_FAIL_CLOSED`, which guards *registered* secret leaks.
 */
export function piiFailClosed(env: EnvSource): boolean | undefined {
  return parseBoolean(env[ENV_FAIL_CLOSED]);
}

/**
 * Per-surface PII gate for a launched coding agent (`ficta claude|codex|pi`). The web/standalone
 * proxy keeps the plain `[pii] enabled` posture; agent launches default *off* even when that is on,
 * because tokenizing an email inside code you're editing is rarely wanted. Precedence, highest first:
 *   1. An explicit shell `FICTA_PII_ENABLED` (captured before TOML is merged) wins either way — the
 *      documented "flip it for a single run" escape hatch. An unparseable value falls through.
 *   2. Otherwise on iff both `[pii] enabled` AND `[pii] agents` are true, so `enabled = false` stays a
 *      single kill switch and `agents = true` alone (with enabled off) is a no-op.
 * cli.ts forces `FICTA_PII_ENABLED` from this result before the proxy builds its engine config, so the
 * engine and every downstream consumer (doctor, /status) see the same answer.
 */
export function resolveAgentPiiEnabled(opts: { shellValue?: string; enabled?: string; agents?: string }): boolean {
  const explicit = parseBoolean(opts.shellValue);
  if (explicit !== undefined) return explicit;
  return envFlag(opts.enabled) && envFlag(opts.agents);
}

interface RecognizerFailure {
  reason: string;
  detail?: string;
  count: number;
}

// A recognizer backend being down is best-effort-degraded, not fatal: record the last failure per
// recognizer (safe metadata only) for discover()/doctor, and throttle the warning per recognizer+reason
// so a dead sidecar does not spam every request. Never logs values or request text. State is kept per
// engine (keyed by its PluginRuntime), so two engines in one process never share counters or throttles.
interface PiiRuntimeState {
  readonly failures: Map<string, RecognizerFailure>;
  // Epoch-ms of the last warning per recognizer+reason. We re-warn once the interval elapses instead
  // of warning only once forever, so a sidecar that stays down keeps surfacing in logs (and the
  // operator is not misled into thinking a single startup warning was transient).
  readonly lastWarnedAt: Map<string, number>;
}

let stateByRuntime = new WeakMap<PluginRuntime, PiiRuntimeState>();
const RE_WARN_INTERVAL_MS = 5 * 60 * 1000;

function runtimeState(runtime: PluginRuntime): PiiRuntimeState {
  let state = stateByRuntime.get(runtime);
  if (!state) {
    state = { failures: new Map(), lastWarnedAt: new Map() };
    stateByRuntime.set(runtime, state);
  }
  return state;
}

function notePiiRecognizerFailure(
  runtime: PluginRuntime,
  name: string,
  err: unknown,
): { reason: string; detail?: string } {
  const { failures, lastWarnedAt } = runtimeState(runtime);
  const classified = classifyRecognizerFailure(err);
  const { reason, detail } = classified;
  const count = (failures.get(name)?.count ?? 0) + 1;
  failures.set(name, { reason, detail, count });

  const warnKey = `${name}:${reason}`;
  const now = Date.now();
  const previous = lastWarnedAt.get(warnKey);
  if (previous !== undefined && now - previous < RE_WARN_INTERVAL_MS) return classified;
  const firstWarning = previous === undefined;
  lastWarnedAt.set(warnKey, now);

  const suffix = detail ? ` (${detail})` : "";
  // Neutral wording: the plugin does not know the resolved fail-open/closed policy (core owns that).
  // The engine's sink (pino, wired by the ficta proxy) gates this at warn; the interval throttle above
  // keeps a dead sidecar from spamming every request while still re-surfacing an ongoing outage.
  // Re-warns carry the running failure count. An engine with no sink stays silent (default no-op).
  const message = firstWarning
    ? `pii backend "${name}" unavailable — ${reason}${suffix}. Run \`ficta doctor\` to diagnose.`
    : `pii backend "${name}" still unavailable — ${reason}${suffix}; ${count} failures since first seen. Run \`ficta doctor\` to diagnose.`;
  runtime.warn({ backend: name, reason, ...(detail ? { detail } : {}), count }, message);
  return classified;
}

function classifyRecognizerFailure(err: unknown): { reason: string; detail?: string } {
  if (err instanceof PresidioUnavailableError || err instanceof OpenmedUnavailableError) {
    return { reason: err.reason, detail: err.detail };
  }
  return { reason: "error", detail: err instanceof Error ? err.name : undefined };
}

/** Snapshot of one engine's last recorded failure per recognizer (safe metadata) — for discover()/tests. */
export function piiRecognizerFailures(runtime: PluginRuntime): Map<string, RecognizerFailure> {
  return new Map(runtimeState(runtime).failures);
}

/** Forget every engine's recorded failures and warning throttles. */
export function resetPiiRecognizerStateForTests(): void {
  stateByRuntime = new WeakMap();
}

/**
 * Best-effort PII detection, off by default. Detected values are tokenized on egress and restored
 * on responses exactly like a registered secret — but detection is a *reduction*, never a guarantee
 * (see docs/threat-model). Self-gates on its own config flag; the core never adds/removes plugins.
 */
export const piiPlugin: DetectorPlugin = {
  kind: "detector",
  name: PLUGIN_NAME,
  bodyDetectionView: "content",
  description:
    "Best-effort PII detection (regex + optional Presidio/OpenMed sidecars), tokenized like any protected value",
  config: {
    envDefaults: {
      [ENV_ENABLED]: "0",
      [ENV_AGENTS]: "0",
      [ENV_FAIL_CLOSED]: "0",
      FICTA_PII_BACKEND: "regex",
      FICTA_PII_BACKENDS: "",
      FICTA_PII_PRESIDIO_URL: "http://127.0.0.1:5002",
      FICTA_PII_PRESIDIO_LANGUAGE: "en",
      FICTA_PII_PRESIDIO_SCORE_THRESHOLD: "0.5",
      FICTA_PII_PRESIDIO_ENTITIES: "",
      FICTA_PII_PRESIDIO_TIMEOUT_MS: "1500",
      FICTA_PII_OPENMED_URL: "http://127.0.0.1:5004",
      FICTA_PII_OPENMED_MODEL: "",
      FICTA_PII_OPENMED_LANG: "en",
      FICTA_PII_OPENMED_SCORE_THRESHOLD: "0.5",
      FICTA_PII_OPENMED_ENTITIES: "",
      FICTA_PII_OPENMED_TIMEOUT_MS: "2500",
    },
    bindings: [
      { env: ENV_ENABLED, path: ["pii", "enabled"], kind: "boolean" },
      { env: ENV_AGENTS, path: ["pii", "agents"], kind: "boolean" },
      { env: ENV_FAIL_CLOSED, path: ["pii", "fail_closed"], kind: "boolean" },
      { env: ENV_BACKEND, path: ["pii", "backend"], kind: "string" },
      { env: ENV_BACKENDS, path: ["pii", "backends"], kind: "string-array-comma" },
      { env: "FICTA_PII_PRESIDIO_URL", path: ["pii", "presidio", "url"], kind: "string" },
      { env: "FICTA_PII_PRESIDIO_LANGUAGE", path: ["pii", "presidio", "language"], kind: "string" },
      { env: "FICTA_PII_PRESIDIO_SCORE_THRESHOLD", path: ["pii", "presidio", "score_threshold"], kind: "number" },
      { env: "FICTA_PII_PRESIDIO_ENTITIES", path: ["pii", "presidio", "entities"], kind: "string-array-comma" },
      { env: "FICTA_PII_PRESIDIO_TIMEOUT_MS", path: ["pii", "presidio", "timeout_ms"], kind: "number" },
      { env: "FICTA_PII_OPENMED_URL", path: ["pii", "openmed", "url"], kind: "string" },
      { env: "FICTA_PII_OPENMED_MODEL", path: ["pii", "openmed", "model"], kind: "string" },
      { env: "FICTA_PII_OPENMED_LANG", path: ["pii", "openmed", "lang"], kind: "string" },
      { env: "FICTA_PII_OPENMED_SCORE_THRESHOLD", path: ["pii", "openmed", "score_threshold"], kind: "number" },
      { env: "FICTA_PII_OPENMED_ENTITIES", path: ["pii", "openmed", "entities"], kind: "string-array-comma" },
      { env: "FICTA_PII_OPENMED_TIMEOUT_MS", path: ["pii", "openmed", "timeout_ms"], kind: "number" },
    ],
    sections: [
      { path: ["pii"], keys: ["enabled", "agents", "fail_closed", "backend", "backends"] },
      { path: ["pii", "presidio"], keys: ["url", "language", "score_threshold", "entities", "timeout_ms"] },
      { path: ["pii", "openmed"], keys: ["url", "model", "lang", "score_threshold", "entities", "timeout_ms"] },
    ],
  },
  setup: {
    registrySources: (ctx) => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label:
          "PII detection — best-effort redaction of emails, SSNs, and card numbers for the web/standalone proxy (off by default; coding-agent launches opt in separately via pii.agents)",
        defaultEnabled: piiEnabled(ctx.env),
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: (runtime) => [discoverPii(runtime)],
  // Exposes the user's per-detector override; the core resolves it against the global default.
  failClosed: (runtime) => runtime.config.pii.failClosed,
  async detectText(text, ctx) {
    const { runtime } = ctx;
    const { pii, detection } = runtime.config;
    if (!text || !pii.enabled) return [];
    const { backends } = resolveBackends(pii.backends);
    const values: ProtectedValue[] = [];
    const failures: string[] = [];

    // NLP/NER backends see Markdown-normalized text — a party name inside a `**heading**` is otherwise
    // missed or mis-bounded. Format-anchored regex recognizers keep the raw text (their email/SSN/card
    // boundary anchors depend on exact punctuation). Normalized text is computed once, lazily.
    let normalized: MarkdownDetectionView | undefined;

    for (const { name, backend } of backends) {
      try {
        // The backend may be sync (regex) or async (a Presidio/NER sidecar); await normalizes both.
        if (!backend.usesNlp) {
          values.push(...(await backend.detect(text, ctx)));
          continue;
        }
        normalized ??= normalizeMarkdownForDetection(text);
        const detected = await backend.detect(normalized.text, ctx);
        values.push(...mapNlpOffsets(detected, normalized));
      } catch (err) {
        const { reason, detail } = notePiiRecognizerFailure(runtime, name, err);
        failures.push(`${name}: ${detail ? `${reason} (${detail})` : reason}`);
      }
    }

    if (failures.length > 0 && detectorFailClosed(pii.failClosed, detection.failClosed)) {
      throw new DetectorUnavailableError(PLUGIN_NAME, failures.join("; "));
    }
    return mergeDetectedValues(values, runtime.config);
  },
};

function mapNlpOffsets(values: readonly ProtectedValue[], view: MarkdownDetectionView): ProtectedValue[] {
  return values.map((value) => {
    const normalizedSpans =
      value.spans ?? expansionSpans(view.text, value.value).map(({ start, end }) => ({ start, end }));
    if (!normalizedSpans || normalizedSpans.length === 0) return value;
    const spans = normalizedSpans.flatMap((span) => {
      const start = view.toRaw(span.start, "start");
      const end = view.toRaw(span.end, "end");
      return start === undefined || end === undefined || start >= end ? [] : [{ start, end }];
    });
    return spans.length > 0 ? { ...value, spans } : value;
  });
}

function discoverPii(runtime: PluginRuntime): PluginDiscovery {
  const { pii, detection } = runtime.config;
  if (!pii.enabled) {
    return {
      id: `${PLUGIN_NAME}/detector`,
      plugin: PLUGIN_NAME,
      label: "PII detector",
      status: "disabled",
      message: `disabled — set ${ENV_ENABLED}=1 (pii.enabled=true) for the web/standalone proxy; coding-agent launches also need ${ENV_AGENTS}=1 (pii.agents=true)`,
    };
  }

  const { backends, unknown } = resolveBackends(pii.backends);
  const backendLabel = backends.map(({ name }) => backendLabelFor(name, runtime)).join(", ");
  const onFailure = detectorFailClosed(pii.failClosed, detection.failClosed) ? "block request" : "skip detection";

  const details: string[] = [];
  for (const name of unknown) details.push(`unknown backend "${name}" — skipped`);
  for (const [failedName, failure] of piiRecognizerFailures(runtime)) {
    details.push(
      `${failedName}: last request failed — ${failure.reason}${failure.detail ? ` (${failure.detail})` : ""}`,
    );
  }

  return {
    id: `${PLUGIN_NAME}/detector`,
    plugin: PLUGIN_NAME,
    label: "PII detector",
    // A detector holds no pre-loaded values — it matches each request at runtime — so report `active`
    // with no valueCount rather than a misleading "(0 values)" that reads as idle.
    status: "active",
    message: `active — matches each request; backends: ${backendLabel}; on backend failure: ${onFailure}; tokenized on egress and restored on responses`,
    details: details.length > 0 ? details : undefined,
  };
}

function backendLabelFor(name: string, runtime: PluginRuntime): string {
  if (name === "presidio") return `presidio (${runtime.config.pii.presidio.url})`;
  if (name === "openmed") return `openmed (${runtime.config.pii.openmed.url})`;
  return name;
}

function mergeDetectedValues(values: readonly ProtectedValue[], config: EngineConfig): ProtectedValue[] {
  const accepted: ProtectedValue[] = [];
  for (const value of values) {
    if (!value.value.trim()) continue;
    const exact = accepted.find((existing) => existing.value === value.value);
    if (exact) {
      const index = accepted.indexOf(exact);
      const preferred = preferValue(value, exact, config);
      accepted[index] = preferred === value ? withMergedSpans(value, exact) : withMergedSpans(exact, value);
      continue;
    }
    // Containment is not duplication. A detector may legitimately return both "Alice Example" and
    // the later standalone "Alice"; dropping the shorter literal here loses that second occurrence
    // before the occurrence resolver can arbitrate the overlapping full-name range. Preserve every
    // distinct literal and let resolveOccurrences() make range-local ownership decisions.
    accepted.push(value);
  }
  return accepted;
}

/**
 * Pick one category for a value several backends (or one backend) reported under different
 * categories. Explicit config decides first (destroy, then `detection.entityPriority`); after that,
 * confidence, medical specificity, and finally the regex floor yields to a configured backend, whose
 * classification is the richer one (the floor exists for coverage, not for labelling).
 */
function preferValue(a: ProtectedValue, b: ProtectedValue, config: EngineConfig): ProtectedValue {
  const configured = compareCategoryClaims(a, b, config);
  if (configured !== 0) return configured < 0 ? a : b;

  const confidence = { exact: 3, high: 2, probabilistic: 1 } as const;
  const aConfidence = confidence[a.confidence ?? "probabilistic"];
  const bConfidence = confidence[b.confidence ?? "probabilistic"];
  if (aConfidence !== bConfidence) return aConfidence > bConfidence ? a : b;

  const aMedical = isMedicalValue(a);
  const bMedical = isMedicalValue(b);
  if (aMedical !== bMedical) return aMedical ? a : b;

  if (a.value.length !== b.value.length) return a.value.length > b.value.length ? a : b;
  const aFloor = a.source === REGEX_FLOOR_SOURCE;
  const bFloor = b.source === REGEX_FLOOR_SOURCE;
  if (aFloor !== bFloor) return aFloor ? b : a;
  if (a.source !== b.source) return a.source < b.source ? a : b;
  // Last resort, so backend result order never decides: lexical category order.
  return a.name <= b.name ? a : b;
}

/** Medical-specific detections win ties: the clinical backends' labels beat generic ones. */
function isMedicalValue(value: ProtectedValue): boolean {
  return value.source === "pii-openmed" || value.name.includes("medical") || value.name.includes("health");
}
