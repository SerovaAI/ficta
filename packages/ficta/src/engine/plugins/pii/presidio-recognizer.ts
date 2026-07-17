import { isRecord } from "../../json.js";
import type { ProtectedValue } from "../types.js";
import type { PiiRecognizer } from "./recognizer.js";

/**
 * Out-of-process PII recognizer backed by a Microsoft Presidio `presidio-analyzer` REST sidecar.
 * ficta does not manage the sidecar's lifecycle — you run it (e.g. via Docker) and point ficta at
 * its URL. Detection is best-effort: on any transport/response failure this recognizer THROWS a
 * {@link PresidioUnavailableError}; the PII plugin owns the failure policy (fail-open by default,
 * dropping only this recognizer's contribution and keeping the others').
 *
 * Contract notes specific to a network recognizer:
 * - Body surface only. Headers/query are redacted per-component, so calling a sidecar there would
 *   fan one request into dozens of round-trips; those surfaces stay regex-only.
 * - Presidio span offsets are Python code-point indices, not UTF-16 — see {@link makeCodepointIndexer}.
 */

const DEFAULT_URL = "http://127.0.0.1:5002";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_SCORE_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT_MS = 1500;

/** Analyzers may return low-quality short/generic spans (e.g. a 2-char token); a registered value
 *  replaces EVERY occurrence body-wide, so anything shorter than this is dropped to protect prose. */
export const MIN_PII_VALUE_LENGTH = 4;
/** At/above this analyzer score a span is treated as high-confidence; below it, probabilistic. */
export const HIGH_CONFIDENCE_SCORE = 0.85;

const MAX_CHUNK_CHARS = 20_000;
const CHUNK_OVERLAP_CHARS = 128;
export const MAX_CONCURRENCY = 4;

/** Tabs delimit independent fields, and generic name entities must contain at least one letter. */
function isInvalidNamedEntitySpan(entityType: string, value: string): boolean {
  return /^(?:LOCATION|ORGANIZATION|PERSON)$/iu.test(entityType) && (value.includes("\t") || !/\p{L}/u.test(value));
}

export interface PresidioConfig {
  url: string;
  language: string;
  scoreThreshold: number;
  /**
   * Optional entity allowlist (FICTA_PII_PRESIDIO_ENTITIES). Empty (the default) omits the
   * `entities` field from /analyze: the sidecar runs every recognizer its registry loaded, scoped
   * at load time by the deployment's country filter (FICTA_PRESIDIO_SUPPORTED_COUNTRIES — see
   * presidio/default_recognizers.yaml). A non-empty list narrows detection to exactly these types
   * (sent to the analyzer AND re-applied client-side).
   *
   * HAZARD: the sidecar's identity recognizer emits its NER entities (PERSON, ORGANIZATION,
   * DATE_TIME, LOCATION, COMPANY_REGISTRATION) only when the request either omits `entities` or
   * lists them. A partial allowlist that names structured types but omits the NER names silently
   * disables all NER coverage. Configure the complete set you intend, or leave unset.
   */
  entities: readonly string[];
  /** Wall-clock budget for the whole detection call (all chunk requests share one deadline). */
  timeoutMs: number;
}

/** Read presidio config from env, with code fallbacks mirroring the plugin's envDefaults. */
export function presidioConfig(env: NodeJS.ProcessEnv = process.env): PresidioConfig {
  return {
    url: stripTrailingSlash(env.FICTA_PII_PRESIDIO_URL?.trim() || DEFAULT_URL),
    language: env.FICTA_PII_PRESIDIO_LANGUAGE?.trim() || DEFAULT_LANGUAGE,
    scoreThreshold: readNumber(env.FICTA_PII_PRESIDIO_SCORE_THRESHOLD, DEFAULT_SCORE_THRESHOLD),
    entities: readList(env.FICTA_PII_PRESIDIO_ENTITIES),
    timeoutMs: readPositiveInt(env.FICTA_PII_PRESIDIO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export type PresidioFailureReason = "unreachable" | "timeout" | "http_error" | "bad_response";

/** Typed backend failure. `detail` is safe metadata (status code, host, budget) — never request text. */
export class PresidioUnavailableError extends Error {
  constructor(
    readonly reason: PresidioFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `presidio ${reason}: ${detail}` : `presidio ${reason}`);
    this.name = "PresidioUnavailableError";
  }
}

interface PresidioSpan {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface TextChunk {
  text: string;
  /** Absolute UTF-16 offset of `text` in the recognizer input. */
  base: number;
}

export const presidioRecognizer: PiiRecognizer = {
  name: "presidio",
  usesNlp: true,
  async detect(text, ctx) {
    // No per-request entity selection: deployment scope is the sidecar registry's load-time
    // country filter (FICTA_PRESIDIO_SUPPORTED_COUNTRIES / presidio/default_recognizers.yaml).
    // An /analyze payload without `entities` runs every loaded recognizer — which IS the
    // deployment's intended detection surface. FICTA_PII_PRESIDIO_ENTITIES remains an optional
    // narrowing knob.
    return detectWithPresidioCompatibleAnalyzer(text, ctx, presidioConfig(), "presidio");
  },
};

export async function detectWithPresidioCompatibleAnalyzer(
  text: string,
  ctx: Parameters<PiiRecognizer["detect"]>[1],
  config: PresidioConfig,
  sourceLabel: string,
): Promise<ProtectedValue[]> {
  // One sidecar round-trip per request body; per-component header/query calls stay regex-only.
  if (!text || ctx.surface !== "body") return [];
  const chunks = chunkText(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const perChunk = await mapConcurrent(chunks, MAX_CONCURRENCY, (chunk) =>
      detectChunk(config, chunk, controller.signal, sourceLabel),
    );
    return dedupeByValue(perChunk.flat());
  } catch (err) {
    controller.abort(); // cancel any still-in-flight sibling requests before surfacing the failure
    throw asPresidioError(err, config);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /health for `ficta doctor`. Never throws — returns a safe reachability verdict. */
export async function checkPresidioHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; url: string; detail?: string }> {
  return checkPresidioCompatibleAnalyzerHealth(presidioConfig(env));
}

export async function checkPresidioCompatibleAnalyzerHealth(
  config: Pick<PresidioConfig, "url" | "timeoutMs">,
): Promise<{ ok: boolean; url: string; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.url}/health`, { signal: controller.signal });
    return res.ok ? { ok: true, url: config.url } : { ok: false, url: config.url, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      url: config.url,
      detail: isAbortError(err) ? `timeout after ${config.timeoutMs}ms` : connectionErrorCode(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function detectChunk(
  config: PresidioConfig,
  chunk: TextChunk,
  signal: AbortSignal,
  sourceLabel: string,
): Promise<ProtectedValue[]> {
  const spans = await analyzeChunk(config, chunk.text, signal);
  return spansToValues(chunk.text, spans, config, sourceLabel, chunk.base);
}

async function analyzeChunk(config: PresidioConfig, chunk: string, signal: AbortSignal): Promise<PresidioSpan[]> {
  const payload: Record<string, unknown> = {
    text: chunk,
    language: config.language,
    score_threshold: config.scoreThreshold,
  };
  if (config.entities.length > 0) payload.entities = config.entities;

  let res: Response;
  try {
    res = await fetch(`${config.url}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw new PresidioUnavailableError("timeout", `${config.timeoutMs}ms`);
    throw new PresidioUnavailableError("unreachable", safeHost(config.url));
  }
  if (!res.ok) throw new PresidioUnavailableError("http_error", String(res.status));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new PresidioUnavailableError("bad_response", "invalid JSON");
  }
  if (!Array.isArray(json)) throw new PresidioUnavailableError("bad_response", "expected span array");

  const spans: PresidioSpan[] = [];
  for (const item of json) {
    const span = toSpan(item);
    if (!span) throw new PresidioUnavailableError("bad_response", "malformed span");
    spans.push(span);
  }
  return spans;
}

function spansToValues(
  chunk: string,
  spans: readonly PresidioSpan[],
  config: PresidioConfig,
  sourceLabel: string,
  base: number,
): ProtectedValue[] {
  const index = makeCodepointIndexer(chunk);
  const allowlist =
    config.entities.length > 0 ? new Set(config.entities.map((entity) => entity.toUpperCase())) : undefined;
  const out: ProtectedValue[] = [];

  for (const span of spans) {
    if (span.score < config.scoreThreshold) continue;
    if (allowlist && !allowlist.has(span.entity_type.toUpperCase())) continue;

    // Trim the sliced span: Markdown normalization masks formatting to spaces (so a `**NAME**` span can
    // slice with space edges), and spaCy NER commonly over-extends across whitespace. Storing the trimmed
    // value tightens the boundary and keeps it a substring of the original text for value-based redaction.
    const localStart = index.toUtf16(span.start);
    const localEnd = index.toUtf16(span.end);
    if (localStart === undefined || localEnd === undefined || localStart >= localEnd) continue;
    const raw = chunk.slice(localStart, localEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const value = raw.trim();
    if (value.length < MIN_PII_VALUE_LENGTH) continue;
    if (isInvalidNamedEntitySpan(span.entity_type, value)) continue;

    out.push({
      name: categoryOf(span.entity_type),
      value,
      source: `pii-${sourceLabel}`,
      kind: "pii",
      confidence: span.score >= HIGH_CONFIDENCE_SCORE ? "high" : "probabilistic",
      spans: [{ start: base + localStart + leading, end: base + localEnd - trailing }],
    });
  }
  return out;
}

/** PERSON → "person", PHONE_NUMBER → "phone-number". A safe category label, never the value. */
export function categoryOf(entityType: string): string {
  return entityType.toLowerCase().replaceAll("_", "-");
}

/**
 * Presidio returns Python string offsets (code-point indices); JS strings are UTF-16, so an astral
 * char (emoji, some CJK) before a span would shift every subsequent slice. Fast path when the text
 * has no surrogate pairs (offsets already match); otherwise build a code-point → UTF-16 index map.
 */
export function makeCodepointIndexer(text: string): {
  slice(start: number, end: number): string;
  toUtf16(offset: number): number | undefined;
} {
  if (!/[\uD800-\uDBFF]/.test(text)) {
    const toUtf16 = (offset: number): number | undefined =>
      Number.isInteger(offset) && offset >= 0 && offset <= text.length ? offset : undefined;
    return {
      slice: (start, end) => {
        const utf16Start = toUtf16(start);
        const utf16End = toUtf16(end);
        return utf16Start === undefined || utf16End === undefined || utf16Start >= utf16End
          ? ""
          : text.slice(utf16Start, utf16End);
      },
      toUtf16,
    };
  }
  const offsets: number[] = [];
  let utf16 = 0;
  for (const ch of text) {
    offsets.push(utf16);
    utf16 += ch.length; // 2 for an astral code point, 1 otherwise
  }
  offsets.push(utf16); // sentinel so `end === codePointCount` maps to text.length
  return {
    slice(start, end) {
      if (start < 0 || end >= offsets.length || start >= end) return "";
      return text.slice(offsets[start], offsets[end]);
    },
    toUtf16(offset) {
      return Number.isInteger(offset) && offset >= 0 && offset < offsets.length ? offsets[offset] : undefined;
    },
  };
}

/** Newline-first chunking for joined redactable body leaves; hard-split giant lines. */
export function chunkText(text: string): TextChunk[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, base: 0 }];
  const chunks: TextChunk[] = [];
  let current = "";
  let currentBase = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if (line.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push({ text: current, base: currentBase });
        current = "";
      }
      chunks.push(...hardSplit(line, lineStart));
    } else {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > MAX_CHUNK_CHARS) {
        if (current) chunks.push({ text: current, base: currentBase });
        current = line;
        currentBase = lineStart;
      } else {
        if (!current) currentBase = lineStart;
        current = candidate;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (current) chunks.push({ text: current, base: currentBase });
  return chunks;
}

function hardSplit(line: string, base: number): TextChunk[] {
  const pieces: TextChunk[] = [];
  const step = MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS;
  for (let start = 0; start < line.length; start += step) {
    pieces.push({ text: line.slice(start, start + MAX_CHUNK_CHARS), base: base + start });
    if (start + MAX_CHUNK_CHARS >= line.length) break;
  }
  return pieces;
}

/** Run `fn` over items with bounded concurrency, preserving input order. Rejects on first failure. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export function dedupeByValue(values: readonly ProtectedValue[]): ProtectedValue[] {
  const byValue = new Map<string, number>();
  const out: ProtectedValue[] = [];
  for (const value of values) {
    const existingIndex = byValue.get(value.value);
    if (existingIndex !== undefined) {
      const existing = out[existingIndex];
      if (existing) out[existingIndex] = withMergedSpans(existing, value);
      continue;
    }
    byValue.set(value.value, out.length);
    out.push(value);
  }
  return out;
}

/** Keep first-value metadata while unioning request-local coordinates from duplicate detections. */
export function withMergedSpans(primary: ProtectedValue, secondary: ProtectedValue): ProtectedValue {
  const spans = [...(primary.spans ?? []), ...(secondary.spans ?? [])]
    .filter(
      (span) => Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter(
      (span, index, all) => index === 0 || span.start !== all[index - 1]?.start || span.end !== all[index - 1]?.end,
    );
  return spans.length > 0 ? { ...primary, spans } : primary;
}

function toSpan(item: unknown): PresidioSpan | undefined {
  if (!isRecord(item)) return undefined;
  const { entity_type: entityType, start, end, score } = item;
  if (typeof entityType !== "string") return undefined;
  if (typeof start !== "number" || typeof end !== "number" || typeof score !== "number") return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return undefined;
  return { entity_type: entityType, start, end, score };
}

function asPresidioError(err: unknown, config: PresidioConfig): PresidioUnavailableError {
  if (err instanceof PresidioUnavailableError) return err;
  if (isAbortError(err)) return new PresidioUnavailableError("timeout", `${config.timeoutMs}ms`);
  return new PresidioUnavailableError("unreachable", safeHost(config.url));
}

/** Node's fetch wraps the transport failure in `err.cause`; surface its code (e.g. ECONNREFUSED). */
function connectionErrorCode(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : "connection failed";
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: unknown }).name === "AbortError" || (err as { name?: unknown }).name === "TimeoutError")
  );
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
