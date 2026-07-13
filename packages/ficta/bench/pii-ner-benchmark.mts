import { readFile } from "node:fs/promises";

interface ExpectedFinding {
  value: string;
  entity: string;
}

interface Fixture {
  name: string;
  text: string;
  expected: ExpectedFinding[];
  mustRemainVisible: string[];
}

interface AnalyzerFinding {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

interface BenchmarkResult {
  label: string;
  identityRecall: number;
  legalPrecision: number;
  expected: number;
  detected: number;
  negativeControls: number;
  rejectedNegativeControls: number;
  misses: Array<{ fixture: string; value: string; entity: string }>;
  falsePositives: Array<{ fixture: string; value: string }>;
}

const ANALYZER_TIMEOUT_MS = 30_000;

const fixtureUrl = new URL("./fixtures/pii-legal-identity.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture[];
const targets = parseTargets(process.argv.slice(2));

if (targets.length === 0) {
  throw new Error(
    "Pass at least one analyzer, e.g. --spacy-url=http://127.0.0.1:5002 or --gliner-url=http://127.0.0.1:5012",
  );
}

const results: BenchmarkResult[] = [];
for (const target of targets) results.push(await benchmark(target.label, target.url));

const [spacy, gliner] = [
  results.find(({ label }) => label === "spacy"),
  results.find(({ label }) => label === "gliner"),
];
const recommendation =
  spacy && gliner
    ? gliner.identityRecall >= spacy.identityRecall + 0.02 && gliner.legalPrecision >= spacy.legalPrecision + 0.02
      ? "gliner"
      : "spacy"
    : results[0]?.label;

console.log(JSON.stringify({ corpus: fixtures.length, results, recommendation }, null, 2));

async function benchmark(label: string, url: string): Promise<BenchmarkResult> {
  let expected = 0;
  let detected = 0;
  let negativeControls = 0;
  let rejectedNegativeControls = 0;
  const misses: BenchmarkResult["misses"] = [];
  const falsePositives: BenchmarkResult["falsePositives"] = [];

  for (const fixture of fixtures) {
    const findings = await analyze(label, url, fixture.text);
    const values = findings.map((finding) => ({
      entity: finding.entity_type,
      value: fixture.text.slice(finding.start, finding.end),
      start: finding.start,
      end: finding.end,
    }));

    for (const item of fixture.expected) {
      expected += 1;
      const expectedStart = fixture.text.indexOf(item.value);
      const expectedEnd = expectedStart + item.value.length;
      if (
        expectedStart >= 0 &&
        values.some(
          (finding) => finding.entity === item.entity && finding.start <= expectedStart && finding.end >= expectedEnd,
        )
      )
        detected += 1;
      else misses.push({ fixture: fixture.name, ...item });
    }
    for (const value of fixture.mustRemainVisible) {
      negativeControls += 1;
      const controlSpans = literalSpans(fixture.text, value);
      if (controlSpans.length === 0)
        throw new Error(`${fixture.name}: missing negative control ${JSON.stringify(value)}`);
      if (
        values.some((finding) =>
          controlSpans.some((control) => finding.start < control.end && finding.end > control.start),
        )
      ) {
        falsePositives.push({ fixture: fixture.name, value });
      } else {
        rejectedNegativeControls += 1;
      }
    }
  }

  return {
    label,
    identityRecall: expected === 0 ? 1 : detected / expected,
    legalPrecision: negativeControls === 0 ? 1 : rejectedNegativeControls / negativeControls,
    expected,
    detected,
    negativeControls,
    rejectedNegativeControls,
    misses,
    falsePositives,
  };
}

function literalSpans(text: string, value: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= text.length - value.length) {
    const start = text.indexOf(value, from);
    if (start === -1) break;
    spans.push({ start, end: start + value.length });
    from = start + Math.max(value.length, 1);
  }
  return spans;
}

async function analyze(label: string, url: string, text: string): Promise<AnalyzerFinding[]> {
  const endpoint = `${url.replace(/\/+$/u, "")}/analyze`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYZER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language: "en", score_threshold: 0.5 }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`${label} analyzer request to ${endpoint} failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) throw new Error(`${label} analyzer ${endpoint} returned HTTP ${response.status}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new Error(`${label} analyzer ${endpoint} returned an unreadable response: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (!Array.isArray(value)) throw new Error(`${label} analyzer ${endpoint} did not return an array`);
    return value as AnalyzerFinding[];
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTargets(args: string[]): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = [];
  for (const arg of args) {
    const match = arg.match(/^--(spacy|gliner)-url=(https?:\/\/.+)$/u);
    if (match?.[1] && match[2]) out.push({ label: match[1], url: match[2] });
  }
  return out;
}
