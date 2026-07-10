// Microbenchmark for the occurrence-based body path.
// Run: pnpm exec tsx bench/entity-redaction-bench.mts
import { ProtectionEngine } from "../src/engine/engine.js";
import { expandEntities } from "../src/engine/expander.js";
import { type Entity, resolveOccurrences } from "../src/engine/occurrence.js";
import type { ProtectedValue } from "../src/plugins/index.js";

const ITERATIONS = 120;
const entityValues = Array.from({ length: 40 }, (_, i) => {
  const first = String.fromCharCode(65 + Math.floor(i / 26));
  const second = String.fromCharCode(65 + (i % 26));
  return `Entity Name ${first}${second}`;
});
const values: ProtectedValue[] = entityValues.map((value, i) => ({
  name: `ENTITY_${i}`,
  value,
  source: "bench",
  kind: "secret",
  confidence: "exact",
}));
const content = `${entityValues.map((value) => `${value} / ${value.toUpperCase()}`).join("\n")}\n${"x".repeat(24_000)}`;
const body = JSON.stringify({ messages: [{ role: "user", content }] });

async function run(): Promise<{ times: number[]; peakHeap: number }> {
  const engine = new ProtectionEngine({ plugins: [], values });
  for (let i = 0; i < 5; i++) await engine.beginRequest().redactBodyDetailed(body);
  const times: number[] = [];
  let peakHeap = process.memoryUsage().heapUsed;
  for (let i = 0; i < ITERATIONS; i++) {
    const started = performance.now();
    await engine.beginRequest().redactBodyDetailed(body);
    times.push(performance.now() - started);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  return { times, peakHeap };
}

function percentiles(times: readonly number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

const entities: Entity[] = values.map((meta, i) => ({
  id: `bench:${i}`,
  canonical: meta.value,
  forms: [meta.value],
  authority: "registry",
  meta,
}));
const peakOccurrences = resolveOccurrences(expandEntities([content], entities)).length;
const occurrence = await run();

console.log(
  JSON.stringify(
    {
      bodyBytes: Buffer.byteLength(body),
      iterations: ITERATIONS,
      peakOccurrences,
      occurrence: { ...percentiles(occurrence.times), peakHeap: occurrence.peakHeap },
    },
    null,
    2,
  ),
);
