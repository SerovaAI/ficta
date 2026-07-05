import { isRecord } from "../../json.js";
import type { ProtectedValue } from "../types.js";
import {
  categoryOf,
  checkPresidioCompatibleAnalyzerHealth,
  chunkText,
  dedupeByValue,
  HIGH_CONFIDENCE_SCORE,
  isAbortError,
  MAX_CONCURRENCY,
  MIN_PII_VALUE_LENGTH,
  mapConcurrent,
  readList,
  readNumber,
  readPositiveInt,
  safeHost,
  stripTrailingSlash,
} from "./presidio-recognizer.js";
import type { PiiRecognizer } from "./recognizer.js";

/**
 * Out-of-process PII recognizer backed by the upstream OpenMed REST service (`openmed[hf,service]`),
 * run unmodified as a sidecar container — the same operational model as Presidio, but a different
 * wire contract: OpenMed's request schemas are strict (unknown fields are rejected with 422) and use
 * `model_name`/`confidence_threshold`/`lang`, and `POST /pii/extract` returns each entity's matched
 * `text` inline, so no code-point→UTF-16 offset conversion is needed. Detection only — ficta owns
 * tokenize/restore; OpenMed's de-identification endpoints are not used.
 *
 * Same failure semantics as the Presidio recognizer: transport/response failures THROW a typed
 * {@link OpenmedUnavailableError}; the PII plugin owns the failure policy (fail-open by default).
 */

const DEFAULT_URL = "http://127.0.0.1:5004";
const DEFAULT_LANG = "en";
const DEFAULT_SCORE_THRESHOLD = 0.5;
/** Transformer inference is slower than Presidio's rule engine; give the sidecar more budget.
 *  Preload the model (OPENMED_SERVICE_PRELOAD_MODELS) so a cold start does not eat it. */
const DEFAULT_TIMEOUT_MS = 2500;

export interface OpenmedConfig {
  url: string;
  /** Model repo id sent as `model_name`; empty = omit the field and use the server's default PII model. */
  model: string;
  lang: string;
  scoreThreshold: number;
  /** Entity allowlist matched against canonical labels, applied client-side (no server-side param). */
  entities: readonly string[];
  /** Wall-clock budget for the whole detection call (all chunk requests share one deadline). */
  timeoutMs: number;
}

/** Read openmed config from env, with code fallbacks mirroring the plugin's envDefaults. */
export function openmedConfig(env: NodeJS.ProcessEnv = process.env): OpenmedConfig {
  return {
    url: stripTrailingSlash(env.FICTA_PII_OPENMED_URL?.trim() || DEFAULT_URL),
    model: env.FICTA_PII_OPENMED_MODEL?.trim() || "",
    lang: env.FICTA_PII_OPENMED_LANG?.trim() || DEFAULT_LANG,
    scoreThreshold: readNumber(env.FICTA_PII_OPENMED_SCORE_THRESHOLD, DEFAULT_SCORE_THRESHOLD),
    entities: readList(env.FICTA_PII_OPENMED_ENTITIES),
    timeoutMs: readPositiveInt(env.FICTA_PII_OPENMED_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export type OpenmedFailureReason = "unreachable" | "timeout" | "http_error" | "bad_response";

/** Typed backend failure. `detail` is safe metadata (status code, host, budget) — never request text. */
export class OpenmedUnavailableError extends Error {
  constructor(
    readonly reason: OpenmedFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `openmed ${reason}: ${detail}` : `openmed ${reason}`);
    this.name = "OpenmedUnavailableError";
  }
}

interface OpenmedEntity {
  /** The matched text itself, returned inline by the service. */
  text: string;
  /** Best label: canonical_label > entity_type > label (models emit varied raw label forms). */
  label: string;
  confidence: number;
}

export const openmedRecognizer: PiiRecognizer = {
  name: "openmed",
  async detect(text, ctx) {
    // One sidecar round-trip per request body; per-component header/query calls stay regex-only.
    if (!text || ctx.surface !== "body") return [];
    const config = openmedConfig();
    const chunks = chunkText(text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const perChunk = await mapConcurrent(chunks, MAX_CONCURRENCY, (chunk) =>
        detectChunk(config, chunk, controller.signal),
      );
      return dedupeByValue(perChunk.flat());
    } catch (err) {
      controller.abort(); // cancel any still-in-flight sibling requests before surfacing the failure
      throw asOpenmedError(err, config);
    } finally {
      clearTimeout(timer);
    }
  },
};

/** GET /health for `ficta doctor`. Never throws — returns a safe reachability verdict. */
export async function checkOpenmedHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; url: string; detail?: string }> {
  return checkPresidioCompatibleAnalyzerHealth(openmedConfig(env));
}

async function detectChunk(config: OpenmedConfig, chunk: string, signal: AbortSignal): Promise<ProtectedValue[]> {
  const entities = await extractChunk(config, chunk, signal);
  return entitiesToValues(entities, config);
}

async function extractChunk(config: OpenmedConfig, chunk: string, signal: AbortSignal): Promise<OpenmedEntity[]> {
  // Strict schema: only fields OpenMed declares; model_name only when configured.
  const payload: Record<string, unknown> = {
    text: chunk,
    confidence_threshold: config.scoreThreshold,
    lang: config.lang,
  };
  if (config.model) payload.model_name = config.model;

  let res: Response;
  try {
    res = await fetch(`${config.url}/pii/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw new OpenmedUnavailableError("timeout", `${config.timeoutMs}ms`);
    throw new OpenmedUnavailableError("unreachable", safeHost(config.url));
  }
  if (!res.ok) throw new OpenmedUnavailableError("http_error", String(res.status));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new OpenmedUnavailableError("bad_response", "invalid JSON");
  }
  // /pii/extract serializes a PredictionResult: `entities` (verified live against v1.7.0).
  // `pii_entities` is accepted as a fallback — it is the de-identify result's key.
  const rows = isRecord(json) ? (json.entities ?? json.pii_entities) : undefined;
  if (!Array.isArray(rows)) {
    throw new OpenmedUnavailableError("bad_response", "expected entities array");
  }

  const entities: OpenmedEntity[] = [];
  for (const item of rows) {
    const entity = toEntity(item);
    if (!entity) throw new OpenmedUnavailableError("bad_response", "malformed entity");
    entities.push(entity);
  }
  return entities;
}

function entitiesToValues(entities: readonly OpenmedEntity[], config: OpenmedConfig): ProtectedValue[] {
  const allowlist =
    config.entities.length > 0 ? new Set(config.entities.map((entity) => entity.toUpperCase())) : undefined;
  const out: ProtectedValue[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    if (entity.confidence < config.scoreThreshold) continue;
    if (allowlist && !allowlist.has(entity.label.toUpperCase())) continue;
    if (entity.text.trim().length < MIN_PII_VALUE_LENGTH) continue;
    if (seen.has(entity.text)) continue;
    seen.add(entity.text);

    out.push({
      name: categoryOf(entity.label),
      value: entity.text,
      source: "pii-openmed",
      kind: "pii",
      confidence: entity.confidence >= HIGH_CONFIDENCE_SCORE ? "high" : "probabilistic",
    });
  }
  return out;
}

function toEntity(item: unknown): OpenmedEntity | undefined {
  if (!isRecord(item)) return undefined;
  const { text, label, entity_type: entityType, canonical_label: canonicalLabel, confidence } = item;
  if (typeof text !== "string" || text.length === 0) return undefined;
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return undefined;
  const bestLabel = [canonicalLabel, entityType, label].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!bestLabel) return undefined;
  return { text, label: bestLabel, confidence };
}

function asOpenmedError(err: unknown, config: OpenmedConfig): OpenmedUnavailableError {
  if (err instanceof OpenmedUnavailableError) return err;
  if (isAbortError(err)) return new OpenmedUnavailableError("timeout", `${config.timeoutMs}ms`);
  return new OpenmedUnavailableError("unreachable", safeHost(config.url));
}
