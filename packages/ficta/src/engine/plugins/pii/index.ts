import { detectorFailClosed } from "../../detection-policy.js";
import { engineWarn } from "../../diagnostics.js";
import { envFlag, parseBoolean } from "../../env-flags.js";
import { DetectorUnavailableError } from "../../redaction-engine.js";
import type { DetectorPlugin, PluginDiscovery, ProtectedValue } from "../types.js";
import { normalizeMarkdownForDetection } from "./markdown.js";
import { OpenmedUnavailableError, openmedConfig } from "./openmed-recognizer.js";
import { PresidioUnavailableError, presidioConfig, withMergedSpans } from "./presidio-recognizer.js";
import type { PiiRecognizer } from "./recognizer.js";
import { activeBackends, ENV_BACKEND, ENV_BACKENDS } from "./registry.js";

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

/** Exported so `ficta doctor` can gate its presidio reachability check on PII actually being on. */
export function piiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[ENV_ENABLED]);
}

/**
 * The user's per-detector fail-closed *override* (`[pii] fail_closed`), exposed for the core resolver
 * and `ficta doctor`. Tri-state: `true`/`false` force the policy, `undefined` (unset) defers to the
 * global `FICTA_FAIL_CLOSED_DETECTION` default. This only reports config — the core enforces it.
 * Independent of `FICTA_FAIL_CLOSED`, which guards *registered* secret leaks.
 */
export function piiFailClosed(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
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
 * The engine and every downstream consumer read `FICTA_PII_ENABLED` at request time, so cli.ts forces
 * that one var from this result before the proxy loads — no per-engine plumbing needed.
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
// so a dead sidecar does not spam every request. Never logs values or request text.
const recognizerFailures = new Map<string, RecognizerFailure>();
// Epoch-ms of the last warning per recognizer+reason. We re-warn once the interval elapses instead of
// warning only once forever, so a sidecar that stays down keeps surfacing in logs (and the operator is
// not misled into thinking a single startup warning was transient).
const lastWarnedAt = new Map<string, number>();
const RE_WARN_INTERVAL_MS = 5 * 60 * 1000;

function notePiiRecognizerFailure(name: string, err: unknown): { reason: string; detail?: string } {
  const classified = classifyRecognizerFailure(err);
  const { reason, detail } = classified;
  const count = (recognizerFailures.get(name)?.count ?? 0) + 1;
  recognizerFailures.set(name, { reason, detail, count });

  const warnKey = `${name}:${reason}`;
  const now = Date.now();
  const previous = lastWarnedAt.get(warnKey);
  if (previous !== undefined && now - previous < RE_WARN_INTERVAL_MS) return classified;
  const firstWarning = previous === undefined;
  lastWarnedAt.set(warnKey, now);

  const suffix = detail ? ` (${detail})` : "";
  // Neutral wording: the plugin does not know the resolved fail-open/closed policy (core owns that).
  // The host sink (pino, wired by ficta) gates this at warn; the interval throttle above keeps a dead
  // sidecar from spamming every request while still re-surfacing an ongoing outage. Re-warns carry the
  // running failure count. A bare-library engine with no sink wired stays silent (default no-op).
  const message = firstWarning
    ? `pii backend "${name}" unavailable — ${reason}${suffix}. Run \`ficta doctor\` to diagnose.`
    : `pii backend "${name}" still unavailable — ${reason}${suffix}; ${count} failures since first seen. Run \`ficta doctor\` to diagnose.`;
  engineWarn({ backend: name, reason, ...(detail ? { detail } : {}), count }, message);
  return classified;
}

function classifyRecognizerFailure(err: unknown): { reason: string; detail?: string } {
  if (err instanceof PresidioUnavailableError || err instanceof OpenmedUnavailableError) {
    return { reason: err.reason, detail: err.detail };
  }
  return { reason: "error", detail: err instanceof Error ? err.name : undefined };
}

/** Snapshot of the last recorded failure per recognizer (safe metadata) — for discover()/tests. */
export function piiRecognizerFailures(): Map<string, RecognizerFailure> {
  return new Map(recognizerFailures);
}

export function resetPiiRecognizerStateForTests(): void {
  recognizerFailures.clear();
  lastWarnedAt.clear();
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
    registrySources: () => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label:
          "PII detection — best-effort redaction of emails, SSNs, and card numbers for the web/standalone proxy (off by default; coding-agent launches opt in separately via pii.agents)",
        defaultEnabled: piiEnabled(),
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: () => [discoverPii()],
  // Exposes the user's per-detector override; the core resolves it against the global default.
  failClosed: piiFailClosed,
  async detectText(text, ctx) {
    if (!text || !piiEnabled()) return [];
    const { backends } = activeBackends();
    const values: ProtectedValue[] = [];
    const failures: string[] = [];

    // NLP/NER backends see Markdown-normalized text — a party name inside a `**heading**` is otherwise
    // missed or mis-bounded. Format-anchored regex recognizers keep the raw text (their email/SSN/card
    // boundary anchors depend on exact punctuation). Normalized text is computed once, lazily.
    let normalized: string | undefined;
    const inputFor = (backend: PiiRecognizer): string => {
      if (!backend.usesNlp) return text;
      normalized ??= normalizeMarkdownForDetection(text);
      return normalized;
    };

    for (const { name, backend } of backends) {
      try {
        // The backend may be sync (regex) or async (a Presidio/NER sidecar); await normalizes both.
        values.push(...(await backend.detect(inputFor(backend), ctx)));
      } catch (err) {
        const { reason, detail } = notePiiRecognizerFailure(name, err);
        failures.push(`${name}: ${detail ? `${reason} (${detail})` : reason}`);
      }
    }

    if (failures.length > 0 && detectorFailClosed(piiFailClosed())) {
      throw new DetectorUnavailableError(PLUGIN_NAME, failures.join("; "));
    }
    return mergeDetectedValues(values);
  },
};

function discoverPii(): PluginDiscovery {
  const enabled = piiEnabled();
  if (!enabled) {
    return {
      id: `${PLUGIN_NAME}/detector`,
      plugin: PLUGIN_NAME,
      label: "PII detector",
      status: "disabled",
      message: `disabled — set ${ENV_ENABLED}=1 (pii.enabled=true) for the web/standalone proxy; coding-agent launches also need ${ENV_AGENTS}=1 (pii.agents=true)`,
    };
  }

  const { backends, unknown } = activeBackends();
  const backendLabel = backends.map(({ name }) => backendLabelFor(name)).join(", ");
  const onFailure = detectorFailClosed(piiFailClosed()) ? "block request" : "skip detection";

  const details: string[] = [];
  for (const name of unknown) details.push(`unknown backend "${name}" — skipped`);
  for (const [failedName, failure] of piiRecognizerFailures()) {
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

function backendLabelFor(name: string): string {
  if (name === "presidio") return `presidio (${presidioConfig().url})`;
  if (name === "openmed") return `openmed (${openmedConfig().url})`;
  return name;
}

function mergeDetectedValues(values: readonly ProtectedValue[]): ProtectedValue[] {
  const accepted: ProtectedValue[] = [];
  for (const value of values) {
    if (!value.value.trim()) continue;
    const exact = accepted.find((existing) => existing.value === value.value);
    if (exact) {
      const index = accepted.indexOf(exact);
      const preferred = preferValue(value, exact);
      accepted[index] = preferred === value ? withMergedSpans(value, exact) : withMergedSpans(exact, value);
      continue;
    }

    const overlaps = accepted.filter((existing) => containsEither(existing.value, value.value));
    if (overlaps.length === 0) {
      accepted.push(value);
      continue;
    }
    if (overlaps.some((existing) => preferValue(existing, value) === existing)) continue;
    for (const overlap of overlaps) accepted.splice(accepted.indexOf(overlap), 1);
    accepted.push(value);
  }
  return accepted;
}

function containsEither(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

function preferValue(a: ProtectedValue, b: ProtectedValue): ProtectedValue {
  const confidence = { exact: 3, high: 2, probabilistic: 1 } as const;
  const aConfidence = confidence[a.confidence ?? "probabilistic"];
  const bConfidence = confidence[b.confidence ?? "probabilistic"];
  if (aConfidence !== bConfidence) return aConfidence > bConfidence ? a : b;

  const aMedical = isMedicalValue(a);
  const bMedical = isMedicalValue(b);
  if (aMedical !== bMedical) return aMedical ? a : b;

  if (a.value.length !== b.value.length) return a.value.length > b.value.length ? a : b;
  return a.source <= b.source ? a : b;
}

/** Medical-specific detections win ties: the clinical backends' labels beat generic ones. */
function isMedicalValue(value: ProtectedValue): boolean {
  return value.source === "pii-openmed" || value.name.includes("medical") || value.name.includes("health");
}
