import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Score an open-weights LLM as a PII span *finder* on ficta's labelled legal fixtures, next to the
 * Presidio sidecar. Unlike the Jev bench (which hands the judge each candidate), the model must find
 * spans itself and quote them verbatim, which is what a redaction detector has to do.
 *
 * Reports one grader per detector (presidio, each --openmed-models entry, llm) and each detector's
 * union with presidio. The union answers the question that matters for a second backend or offline
 * oracle: what does it catch that the policy misses, and at what cost in false positives.
 *
 * Scoring is by character range, not string containment: every occurrence of a quoted span counts,
 * because the engine redacts every occurrence of a detected value. A quote that does not occur in the
 * text is "ungrounded" and scores nothing.
 *
 * Any OpenAI-compatible endpoint works (OpenRouter, vLLM, Ollama). Everything sent is synthetic
 * fixture text. Never import this from `src/`.
 */

interface Fixture {
  name: string;
  text: string;
  expected: Array<{ value: string; entity: string }>;
  mustRemainVisible: string[];
}

interface Range {
  start: number;
  end: number;
}

interface Grade {
  expected: number;
  found: number;
  negativeControls: number;
  falsePositives: number;
  recall: number;
  controlPrecision: number;
  misses: string[];
  falsePositiveValues: string[];
}

interface LlmFinding {
  text: string;
  type: string;
}

const FIXTURE_SETS = {
  legal: "./fixtures/pii-legal-identity.json",
  hard: "./fixtures/pii-legal-hard.json",
  blind: "./fixtures/pii-legal-blind.json",
  holdout: "./fixtures/pii-legal-holdout.json",
  clinical: "./fixtures/pii-clinical-chat.json",
} as const;
type FixtureSet = keyof typeof FIXTURE_SETS;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "qwen/qwen3.6-35b-a3b";
const CACHE_DIR = new URL("./.llm-cache/", import.meta.url);

const SYSTEM_PROMPT = `You find personal and party-identifying information in legal text so it can be redacted before the text is sent to a third-party AI service.

Return every span that identifies a specific real-world party or is one of their personal identifiers:
- person: a named individual, including surnames used alone, initials with a surname, and names written in lowercase or capitals.
- organization: a named company, firm, trust, or institution that is a party or actor, including short aliases of one.
- location: a home address or home city of a person, or a location tied to a party's identity.
- identifier: ID number, email address, phone number, birth date, company registration number, account number.

Do NOT return: contractual roles and defined terms (Company, Borrower, Lender, Disclosing Party), section headings, legal concepts, courts and public institutions acting as courts, governing-law jurisdictions, amounts, rates, durations, agreement or hearing dates, project or facility names, and generic words.

Quote each span exactly as it appears in the text, character for character, without surrounding punctuation. List each distinct span once.`;

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "pii_spans",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["entities"],
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "type"],
            properties: {
              text: { type: "string" },
              type: {
                type: "string",
                enum: ["person", "organization", "location", "identifier"],
              },
            },
          },
        },
      },
    },
  },
};

const options = parseOptions(process.argv.slice(2));
const apiKey = process.env.FICTA_BENCH_LLM_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
if (options.llm && !apiKey && options.baseUrl === DEFAULT_BASE_URL) {
  console.log("Set OPENROUTER_API_KEY (or FICTA_BENCH_LLM_API_KEY) to run against OpenRouter; exiting.");
  process.exit(0);
}

const usage = {
  requests: 0,
  cachedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  latenciesMs: [] as number[],
};
const detectorLatenciesMs = new Map<string, number[]>();
const report: Record<string, unknown> = {
  model: options.llm ? options.model : "skipped (--no-llm)",
  baseUrl: options.baseUrl,
  think: options.think,
  openmedModels: options.openmedUrl ? options.openmedModels : undefined,
};
for (const set of options.sets) report[set] = await scoreSet(set);
report.usage = {
  requests: usage.requests,
  cachedRequests: usage.cachedRequests,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  medianLatencyMs: median(usage.latenciesMs),
  detectorMedianLatencyMs: Object.fromEntries(
    [...detectorLatenciesMs].map(([name, latencies]) => [name, median(latencies)]),
  ),
};
console.log(JSON.stringify(report, null, 2));

async function scoreSet(set: FixtureSet) {
  const fixtures = JSON.parse(await readFile(new URL(FIXTURE_SETS[set], import.meta.url), "utf8")) as Fixture[];
  const detectors = new Map<string, (text: string) => Promise<Range[]>>();
  if (options.presidioUrl) {
    const url = options.presidioUrl;
    detectors.set("presidio", (text) => presidioRanges(url, text));
  }
  if (options.openmedUrl) {
    const url = options.openmedUrl;
    for (const model of options.openmedModels) {
      detectors.set(`openmed:${model}`, (text) => openmedRanges(url, model, text));
    }
  }
  const perFixture: Array<{
    source: Fixture;
    ranges: Map<string, Range[]>;
    ungrounded: string[];
  }> = [];
  for (const fixture of fixtures) {
    const ranges = new Map<string, Range[]>();
    for (const [name, detect] of detectors) {
      const started = performance.now();
      ranges.set(name, await detect(fixture.text));
      const latencies = detectorLatenciesMs.get(name) ?? [];
      latencies.push(Math.round(performance.now() - started));
      detectorLatenciesMs.set(name, latencies);
    }
    const ungrounded: string[] = [];
    if (options.llm) {
      const llm: Range[] = [];
      for (const finding of await llmFindings(fixture.text)) {
        const found = occurrences(fixture.text, finding.text);
        if (found.length === 0) ungrounded.push(finding.text);
        llm.push(...found);
      }
      ranges.set("llm", llm);
    }
    perFixture.push({ source: fixture, ranges, ungrounded });
  }
  const grade = (names: string[]) =>
    aggregate(
      perFixture.map((row) =>
        gradeFixture(
          row.source,
          names.flatMap((name) => row.ranges.get(name) ?? []),
        ),
      ),
    );
  const names = [...(perFixture[0]?.ranges.keys() ?? [])];
  const result: Record<string, unknown> = { fixtures: fixtures.length };
  if (!options.presidioUrl) result.presidio = "pass --presidio-url to score";
  for (const name of names) result[name] = grade([name]);
  if (options.presidioUrl) {
    for (const name of names.filter((name) => name !== "presidio")) {
      result[`presidio ∪ ${name}`] = grade(["presidio", name]);
    }
  }
  if (options.llm) {
    result.ungrounded = perFixture.flatMap((row) => row.ungrounded.map((value) => `${row.source.name}: ${value}`));
  }
  return result;
}

function gradeFixture(fixture: Fixture, detected: Range[]): Grade {
  const overlaps = (value: string) =>
    occurrences(fixture.text, value).some((range) =>
      detected.some((span) => span.start < range.end && range.start < span.end),
    );
  const misses = fixture.expected
    .filter((item) => !overlaps(item.value))
    .map((item) => `${fixture.name}: ${item.entity} ${item.value}`);
  const falsePositiveValues = fixture.mustRemainVisible.filter(overlaps).map((value) => `${fixture.name}: ${value}`);
  return {
    expected: fixture.expected.length,
    found: fixture.expected.length - misses.length,
    negativeControls: fixture.mustRemainVisible.length,
    falsePositives: falsePositiveValues.length,
    recall: 0,
    controlPrecision: 0,
    misses,
    falsePositiveValues,
  };
}

function aggregate(grades: Grade[]): Grade {
  const sum = (key: "expected" | "found" | "negativeControls" | "falsePositives") =>
    grades.reduce((total, grade) => total + grade[key], 0);
  const expected = sum("expected");
  const negativeControls = sum("negativeControls");
  const falsePositives = sum("falsePositives");
  return {
    expected,
    found: sum("found"),
    negativeControls,
    falsePositives,
    recall: round(expected === 0 ? 1 : sum("found") / expected),
    // Share of must-remain-visible controls left intact: the legal-precision proxy the other benches use.
    controlPrecision: round(negativeControls === 0 ? 1 : 1 - falsePositives / negativeControls),
    misses: grades.flatMap((grade) => grade.misses),
    falsePositiveValues: grades.flatMap((grade) => grade.falsePositiveValues),
  };
}

async function llmFindings(text: string): Promise<LlmFinding[]> {
  const body = {
    model: options.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: RESPONSE_SCHEMA,
    // OpenRouter's unified reasoning switch; other OpenAI-compatible servers ignore unknown fields.
    reasoning: { enabled: options.think },
  };
  const key = createHash("sha256")
    .update(JSON.stringify({ baseUrl: options.baseUrl, body }))
    .digest("hex");
  const cached = await readCache(key);
  if (cached) {
    usage.cachedRequests += 1;
    return parseFindings(cached);
  }
  const started = performance.now();
  const response = await fetch(`${options.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${options.baseUrl} returned HTTP ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usage.latenciesMs.push(Math.round(performance.now() - started));
  usage.requests += 1;
  usage.inputTokens += json.usage?.prompt_tokens ?? 0;
  usage.outputTokens += json.usage?.completion_tokens ?? 0;
  const content = json.choices?.[0]?.message?.content ?? "";
  await writeCache(key, content);
  return parseFindings(content);
}

function parseFindings(content: string): LlmFinding[] {
  // Some servers wrap JSON in a code fence even under response_format; take the outermost object.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`model returned no JSON object: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(content.slice(start, end + 1)) as {
    entities?: LlmFinding[];
  };
  return (parsed.entities ?? []).filter((item) => typeof item.text === "string" && item.text.trim() !== "");
}

async function presidioRanges(base: string, text: string): Promise<Range[]> {
  const response = await fetch(`${base.replace(/\/+$/u, "")}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, language: "en", score_threshold: 0.5 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`presidio ${base} returned HTTP ${response.status}`);
  const findings = (await response.json()) as Array<{
    start: number;
    end: number;
  }>;
  return findings.map(({ start, end }) => ({ start, end }));
}

/**
 * OpenMed `/pii/extract` ranges. `model` "default" omits `model_name` so the server's default PII
 * model runs. The Privacy Filter family returns words split at subword boundaries ("Ndl" + "ovu"),
 * so touching same-label fragments are merged before scoring; without that, ficta's value-based
 * redaction would see fragments rather than names.
 */
async function openmedRanges(base: string, model: string, text: string): Promise<Range[]> {
  const payload: Record<string, unknown> = {
    text,
    confidence_threshold: 0.5,
    lang: "en",
  };
  if (model !== "default") payload.model_name = model;
  const response = await fetch(`${base.replace(/\/+$/u, "")}/pii/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // The first call per model downloads and loads it.
    signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok)
    throw new Error(`openmed ${base} (${model}) returned HTTP ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as {
    entities?: Array<{ start: number; end: number; label?: string }>;
  };
  const merged: Array<Range & { label?: string }> = [];
  for (const entity of [...(json.entities ?? [])].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.label === entity.label && entity.start <= last.end) last.end = Math.max(last.end, entity.end);
    else
      merged.push({
        start: entity.start,
        end: entity.end,
        label: entity.label,
      });
  }
  return merged.map(({ start, end }) => ({ start, end }));
}

/** Every occurrence of `value`, exact first, falling back to case-insensitive when there is none. */
function occurrences(text: string, value: string): Range[] {
  const find = (haystack: string, needle: string) => {
    const out: Range[] = [];
    for (let at = haystack.indexOf(needle); at >= 0 && needle !== ""; at = haystack.indexOf(needle, at + 1)) {
      out.push({ start: at, end: at + needle.length });
    }
    return out;
  };
  const exact = find(text, value);
  return exact.length > 0 ? exact : find(text.toLowerCase(), value.toLowerCase());
}

async function readCache(key: string): Promise<string | undefined> {
  try {
    return await readFile(new URL(`${key}.txt`, CACHE_DIR), "utf8");
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, value: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(new URL(`${key}.txt`, CACHE_DIR), value);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseOptions(args: string[]) {
  let baseUrl = process.env.FICTA_BENCH_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let model = process.env.FICTA_BENCH_LLM_MODEL?.trim() || DEFAULT_MODEL;
  let presidioUrl: string | undefined;
  let openmedUrl: string | undefined;
  let openmedModels = ["default"];
  let llm = true;
  let think = false;
  let sets: FixtureSet[] = ["legal", "hard", "blind", "holdout"];
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(`Score PII span finders (an LLM, OpenMed models, Presidio) on ficta's labelled fixtures

  OPENROUTER_API_KEY=... pnpm --filter @serovaai/ficta bench:llm-spans -- [--model=qwen/qwen3.6-35b-a3b]
    [--base-url=https://openrouter.ai/api/v1] [--presidio-url=http://127.0.0.1:5002]
    [--openmed-url=http://127.0.0.1:5004] [--openmed-models=default,openai/privacy-filter] [--no-llm]
    [--sets=legal,hard,blind,holdout,clinical] [--think]

--base-url accepts any OpenAI-compatible server (vLLM, Ollama at http://127.0.0.1:11434/v1).
--think enables the model's reasoning (off by default, to measure the cheap path).
--openmed-models is a comma list of model_name values; "default" uses the server's default PII model.
--no-llm scores only the sidecars (no API key needed). The LLM prompt is written for legal text.
Reports recall and negative-control precision per detector and per detector ∪ presidio. All inputs
are synthetic. LLM responses cache under bench/.llm-cache/.`);
      process.exit(0);
    }
    if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--presidio-url=")) presidioUrl = arg.slice("--presidio-url=".length);
    else if (arg.startsWith("--openmed-url=")) openmedUrl = arg.slice("--openmed-url=".length);
    else if (arg.startsWith("--openmed-models=")) openmedModels = arg.slice("--openmed-models=".length).split(",");
    else if (arg === "--no-llm") llm = false;
    else if (arg === "--think") think = true;
    else if (arg.startsWith("--sets=")) {
      sets = arg
        .slice("--sets=".length)
        .split(",")
        .map((set) => {
          if (!(set in FIXTURE_SETS)) throw new Error(`Unknown fixture set ${set}`);
          return set as FixtureSet;
        });
    } else throw new Error(`Unknown argument ${arg}; run with --help`);
  }
  return {
    baseUrl,
    model,
    presidioUrl,
    openmedUrl,
    openmedModels,
    llm,
    think,
    sets,
  };
}
