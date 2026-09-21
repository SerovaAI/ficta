import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * Bench-only TypeSafe (Jev) client. This file must never be imported from `src/`: the shipped
 * proxy makes no remote judgment calls, and every input sent through here is synthetic fixture
 * text or a corpus the operator has explicitly pointed the bench at. See the plan notes in
 * ficta-internal for the threat-model reasoning.
 */

export const ENV_API_KEY = "TYPESAFE_API_KEY";
const ENV_MODEL = "FICTA_BENCH_JEV_MODEL";
/** Pinned so tuned thresholds keep meaning across `jev-latest` alias moves. */
const DEFAULT_MODEL = "jev-1.13.0";
const CACHE_DIR = new URL("./.jev-cache/", import.meta.url);

export interface JevUsage {
  requests: number;
  cachedRequests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevJudge {
  readonly model: string;
  readonly usage: JevUsage;
  ask<const Q extends Questions>(
    state: Parameters<TypeSafeClient["systemOne"]>[0]["state"],
    questions: Q,
  ): Promise<SystemOneResult<Q>>;
}

export function jevAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[ENV_API_KEY]?.trim());
}

/**
 * Build a judge, or `undefined` with a printed skip notice when no API key is set, so every bench
 * that can run without Jev still exits 0 in CI and on machines without a key.
 */
export function createJevJudge(opts: { timeoutMs?: number; cache?: boolean } = {}): JevJudge | undefined {
  if (!jevAvailable()) {
    console.error(`[jev] ${ENV_API_KEY} is not set; skipping TypeSafe judgments.`);
    return undefined;
  }
  const model = process.env[ENV_MODEL]?.trim() || DEFAULT_MODEL;
  const client = new TypeSafeClient({ timeout: opts.timeoutMs ?? 30_000, defaultModel: model, logLevel: "error" });
  const useCache = opts.cache ?? true;
  const usage: JevUsage = { requests: 0, cachedRequests: 0, inputTokens: 0, outputTokens: 0 };

  return {
    model,
    usage,
    async ask(state, questions) {
      const key = cacheKey(model, state, questions);
      if (useCache) {
        const hit = await readCache(key);
        if (hit) {
          usage.cachedRequests += 1;
          return hit as never;
        }
      }
      const result = await client.systemOne({ state, questions, model });
      usage.requests += 1;
      usage.inputTokens += result.usage.input_tokens;
      usage.outputTokens += result.usage.output_tokens;
      if (useCache) await writeCache(key, result);
      return result;
    },
  };
}

/** Approximate spend at the published input-only rate; output tokens are free. */
export function estimateUsd(usage: JevUsage, usdPerMillionInput = 0.042): number {
  return (usage.inputTokens / 1_000_000) * usdPerMillionInput;
}

function cacheKey(model: string, state: unknown, questions: unknown): string {
  return createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
}

async function readCache(key: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(new URL(`${key}.json`, CACHE_DIR), "utf8"));
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(new URL(`${key}.json`, CACHE_DIR), JSON.stringify(value));
}
