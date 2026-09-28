import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Score an open-weights LLM as a PII span *finder* on ficta's labelled legal fixtures, next to the
 * Presidio sidecar. Unlike the Jev bench (which hands the judge each candidate), the model must find
 * spans itself and quote them verbatim, which is what a redaction detector has to do.
 *
 * Reports three graders per fixture set: presidio, llm, and presidio ∪ llm. The union answers the
 * question that matters for an offline oracle: what does the model catch that the policy misses, and
 * at what cost in false positives.
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
if (!apiKey && options.baseUrl === DEFAULT_BASE_URL) {
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
const report: Record<string, unknown> = {
  model: options.model,
  baseUrl: options.baseUrl,
  think: options.think,
};
for (const set of options.sets) report[set] = await scoreSet(set);
report.usage = {
  requests: usage.requests,
  cachedRequests: usage.cachedRequests,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  medianLatencyMs: median(usage.latenciesMs),
};
console.log(JSON.stringify(report, null, 2));

async function scoreSet(set: FixtureSet) {
  const fixtures = JSON.parse(await readFile(new URL(FIXTURE_SETS[set], import.meta.url), "utf8")) as Fixture[];
  const perFixture: Array<{
    source: Fixture;
    presidio?: Range[];
    llm: Range[];
    ungrounded: string[];
  }> = [];
  for (const fixture of fixtures) {
    const presidio = options.presidioUrl ? await presidioRanges(options.presidioUrl, fixture.text) : undefined;
    const findings = await llmFindings(fixture.text);
    const llm: Range[] = [];
    const ungrounded: string[] = [];
    for (const finding of findings) {
      const ranges = occurrences(fixture.text, finding.text);
      if (ranges.length === 0) ungrounded.push(finding.text);
      llm.push(...ranges);
    }
    perFixture.push({ source: fixture, presidio, llm, ungrounded });
  }
  type Row = (typeof perFixture)[number];
  const grade = (pick: (row: Row) => Range[]) =>
    aggregate(perFixture.map((row) => gradeFixture(row.source, pick(row))));
  return {
    fixtures: fixtures.length,
    presidio: options.presidioUrl ? grade((row) => row.presidio ?? []) : "pass --presidio-url to score",
    llm: grade((row) => row.llm),
    union: options.presidioUrl ? grade((row) => [...(row.presidio ?? []), ...row.llm]) : undefined,
    ungrounded: perFixture.flatMap((row) => row.ungrounded.map((value) => `${row.source.name}: ${value}`)),
  };
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
  let think = false;
  let sets: FixtureSet[] = ["legal", "hard", "blind", "holdout"];
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(`Score an LLM as a PII span finder on ficta's labelled legal fixtures

  OPENROUTER_API_KEY=... pnpm --filter @serovaai/ficta bench:llm-spans -- [--model=qwen/qwen3.6-35b-a3b]
    [--base-url=https://openrouter.ai/api/v1] [--presidio-url=http://127.0.0.1:5002] [--sets=legal,hard,blind,holdout] [--think]

--base-url accepts any OpenAI-compatible server (vLLM, Ollama at http://127.0.0.1:11434/v1).
--think enables the model's reasoning (off by default, to measure the cheap path).
Reports recall and negative-control precision for presidio, llm and presidio ∪ llm. All inputs are
synthetic. Responses cache under bench/.llm-cache/.`);
      process.exit(0);
    }
    if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--presidio-url=")) presidioUrl = arg.slice("--presidio-url=".length);
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
  return { baseUrl, model, presidioUrl, think, sets };
}
