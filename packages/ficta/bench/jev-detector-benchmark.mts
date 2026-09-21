import { readFile } from "node:fs/promises";
import { choice, noul } from "@typesafe-ai/sdk";
import { detectSecretShapes } from "../src/engine/plugins/secret-shapes/index.js";
import { createJevJudge, ENV_API_KEY, estimateUsd, type JevJudge } from "./jev-judge.js";

/**
 * Score TypeSafe (Jev) against ficta's own labelled fixtures so it is graded by ground truth,
 * not by what the regex detector happened to catch.
 *
 * Two tracks, each reporting precision/recall for the existing detector and for Jev:
 *   secrets  — bench/fixtures/secret-shapes-labelled.json: each entry is one snippet with one
 *              candidate token labelled credential|benign. Jev judges the token in context.
 *   pii      — bench/fixtures/pii-legal-identity.json: per fixture, every expected span and every
 *              must-remain-visible control is a candidate. Jev judges each span in the document;
 *              the Presidio sidecar (--presidio-url) is the optional baseline.
 *
 * Everything sent to TypeSafe is synthetic fixture text.
 */

interface SecretEntry {
  id: string;
  label: "credential" | "benign";
  parts: string[];
  join: string;
  template: string;
}

interface PiiFixture {
  name: string;
  text: string;
  expected: Array<{ value: string; entity: string }>;
  mustRemainVisible: string[];
}

interface Verdicts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
}

interface Row {
  id: string;
  label: string;
  baseline: boolean | null;
  jev: boolean;
  jevProbability: number;
  jevKind?: string;
  jevConfidence?: number;
}

const SECRET_THRESHOLD = 0.5;
const PII_THRESHOLD = 0.5;
const PII_ENTITY_OF_INTEREST = new Set([
  "PERSON",
  "ORGANIZATION",
  "LOCATION",
  "DATE_TIME",
  "EMAIL_ADDRESS",
  "ZA_ID_NUMBER",
  "COMPANY_REGISTRATION",
]);

const options = parseOptions(process.argv.slice(2));
const judge = createJevJudge();
if (!judge) {
  console.log(`Set ${ENV_API_KEY} to score Jev against the fixtures; exiting without a report.`);
  process.exit(0);
}

const report: Record<string, unknown> = { model: judge.model, mask: options.mask };
if (options.tracks.has("secrets")) report.secrets = await secretsTrack(judge, options.mask);
if (options.tracks.has("pii")) report.pii = await piiTrack(judge, options.presidioUrl, options.mask);
report.usage = { ...judge.usage, estimatedUsd: Math.round(estimateUsd(judge.usage) * 10_000) / 10_000 };
console.log(JSON.stringify(report, null, 2));

async function secretsTrack(jev: JevJudge, mask: boolean) {
  const url = new URL("./fixtures/secret-shapes-labelled.json", import.meta.url);
  const entries = JSON.parse(await readFile(url, "utf8")) as SecretEntry[];
  const rows: Row[] = [];
  for (const entry of entries) {
    const value = entry.parts.join(entry.join);
    const snippet = entry.template.replaceAll("{value}", value);
    const found = detectSecretShapes(snippet).find((item) => item.value === value || value.includes(item.value));
    const baseline = found !== undefined;
    const shown = mask ? maskToken(value) : value;
    const { answers } = await jev.ask(
      mask
        ? {
            snippet: snippet.replaceAll(value, shown),
            token: shown,
            token_note:
              "Letters and digits in `token` are masked: a=lowercase, A=uppercase, 0=digit. Judge by shape and context.",
            token_length: value.length,
            detector_category: found?.name ?? "none",
          }
        : { snippet, token: value },
      {
        kind: choice("What is `token` as it appears in `snippet`? Judge the token, not the rest of the line.", {
          credential: "A live API key, token, password, private key, or signing secret that grants access if leaked.",
          placeholder: "A sample, dummy, or template value standing in for a credential in docs or tests.",
          identifier: "A program identifier, variable, property chain, or i18n message key.",
          hash_or_digest: "A content hash, commit SHA, checksum, or image digest.",
          path_or_url: "A filesystem path or a URL without a literal password.",
          encoded_data: "Base64 or hex payload that is data, such as an image.",
          other: "None of the above.",
        }),
        secret: noul(
          "Would a careful developer keep `token` out of a chat transcript sent to a third-party AI service?",
          {
            true: "Sharing it could grant access or reveal a secret.",
            false: "It is harmless to share: public code, a placeholder, a hash, or a path.",
          },
        ),
      },
    );
    rows.push({
      id: entry.id,
      label: entry.label,
      baseline,
      // The kind Choice is the verdict: an interpretive Noul ("would a developer keep this out of a
      // transcript") over-fires on code that merely refers to a secret. Kept for the disagreement log.
      jev: answers.kind.choice === "credential",
      jevProbability: round(answers.secret.noul),
      jevKind: answers.kind.choice,
      jevConfidence: round(answers.kind.confidence),
    });
  }
  const positive = (row: Row) => row.label === "credential";
  return {
    fixture: "secret-shapes-labelled",
    entries: rows.length,
    threshold: SECRET_THRESHOLD,
    baseline: metrics(tally(rows, positive, (row) => row.baseline === true)),
    jev: metrics(tally(rows, positive, (row) => row.jev)),
    jevBySecretNoul: metrics(tally(rows, positive, (row) => row.jevProbability >= SECRET_THRESHOLD)),
    // The filter design: Jev only ever sees what regex flagged, so this subset is what matters.
    jevOnRegexCandidates: metrics(
      tally(
        rows.filter((row) => row.baseline === true),
        positive,
        (row) => row.jev,
      ),
    ),
    disagreements: rows.filter((row) => row.baseline !== row.jev || row.jev !== positive(row)),
  };
}

async function piiTrack(jev: JevJudge, presidioUrl?: string, mask = false) {
  const url = new URL("./fixtures/pii-legal-identity.json", import.meta.url);
  const fixtures = JSON.parse(await readFile(url, "utf8")) as PiiFixture[];
  const rows: Row[] = [];
  for (const fixture of fixtures) {
    const baselineSpans = presidioUrl ? await presidioSpans(presidioUrl, fixture.text) : undefined;
    const candidates = [
      ...fixture.expected.map((item) => ({ value: item.value, entity: item.entity, positive: true })),
      ...fixture.mustRemainVisible.map((value) => ({ value, entity: "NONE", positive: false })),
    ];
    for (const candidate of candidates) {
      const { answers } = await jev.ask(
        mask ? maskedPiiState(fixture, candidate.value) : { document: fixture.text, span: candidate.value },
        {
          identity: noul(
            "In `document`, does `span` name a specific real-world person, company, or organisation, or give one of their personal identifiers (ID number, email, birth date, registration number, home city)?",
            {
              true: "It identifies a party or is one of their personal identifiers.",
              false: "It is a role word, legal term, amount, duration, generic date, or other commercial fact.",
            },
          ),
          kind: choice("What kind of thing is `span` in `document`?", {
            person: "A named individual.",
            organization: "A named company, firm, trust, or institution, including short aliases of one.",
            identifier:
              "A personal or corporate identifier: ID number, email, registration number, birth date, home location.",
            role_or_legal_term:
              "A contractual role or legal concept such as Borrower, Security Interest, Supreme Court.",
            commercial_fact: "An amount, rate, duration, deadline, project name, or other business term.",
            other: "None of the above.",
          }),
        },
      );
      rows.push({
        id: `${fixture.name}: ${candidate.value}`,
        label: candidate.positive ? candidate.entity : "benign",
        baseline: baselineSpans
          ? baselineSpans.some((span) => span.value === candidate.value || span.value.includes(candidate.value))
          : null,
        jev: answers.identity.noul >= PII_THRESHOLD,
        jevProbability: round(answers.identity.noul),
        jevKind: answers.kind.choice,
        jevConfidence: round(answers.kind.confidence),
      });
    }
  }
  const positive = (row: Row) => row.label !== "benign";
  return {
    fixture: "pii-legal-identity",
    candidates: rows.length,
    threshold: PII_THRESHOLD,
    baseline: presidioUrl
      ? metrics(tally(rows, positive, (row) => row.baseline === true))
      : "pass --presidio-url=http://127.0.0.1:5002 to score the sidecar",
    jev: metrics(tally(rows, positive, (row) => row.jev)),
    jevByEntity: Object.fromEntries(
      [...PII_ENTITY_OF_INTEREST].map((entity) => {
        const subset = rows.filter((row) => row.label === entity);
        return [entity, { expected: subset.length, found: subset.filter((row) => row.jev).length }];
      }),
    ),
    disagreements: rows.filter(
      (row) => row.jev !== positive(row) || (row.baseline !== null && row.baseline !== positive(row)),
    ),
  };
}

/** Class-mask every letter and digit so only length, separators and case pattern survive. */
function maskToken(value: string): string {
  return value.replaceAll(/[a-z]/gu, "a").replaceAll(/[A-Z]/gu, "A").replaceAll(/[0-9]/gu, "0");
}

/**
 * Production shape: every true identity span is already a surrogate, and the candidate under
 * judgement is one too. Jev sees only context. Longest surfaces first so aliases nest correctly.
 */
function maskedPiiState(fixture: PiiFixture, span: string) {
  let document = fixture.text;
  const surfaces = [...new Set([span, ...fixture.expected.map((item) => item.value)])].sort(
    (a, b) => b.length - a.length,
  );
  surfaces.forEach((surface, index) => {
    document = document.split(surface).join(surface === span ? "[TARGET]" : `[REDACTED_${index}]`);
  });
  return {
    document,
    span: "[TARGET]",
    note: "Identity spans were replaced by placeholders before you saw this document. Judge [TARGET] from its context only.",
  };
}

async function presidioSpans(base: string, text: string): Promise<Array<{ value: string; entity: string }>> {
  const response = await fetch(`${base.replace(/\/+$/u, "")}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, language: "en", score_threshold: 0.5 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`presidio ${base} returned HTTP ${response.status}`);
  const findings = (await response.json()) as Array<{ entity_type: string; start: number; end: number }>;
  return findings.map((finding) => ({ value: text.slice(finding.start, finding.end), entity: finding.entity_type }));
}

function tally(rows: Row[], positive: (row: Row) => boolean, predicted: (row: Row) => boolean): Verdicts {
  const out: Verdicts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  for (const row of rows) {
    const actual = positive(row);
    const guess = predicted(row);
    if (actual && guess) out.truePositive += 1;
    else if (!actual && guess) out.falsePositive += 1;
    else if (actual && !guess) out.falseNegative += 1;
    else out.trueNegative += 1;
  }
  return out;
}

function metrics(v: Verdicts) {
  const precision = v.truePositive + v.falsePositive === 0 ? 1 : v.truePositive / (v.truePositive + v.falsePositive);
  const recall = v.truePositive + v.falseNegative === 0 ? 1 : v.truePositive / (v.truePositive + v.falseNegative);
  return { ...v, precision: round(precision), recall: round(recall) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseOptions(args: string[]): { tracks: Set<"secrets" | "pii">; presidioUrl?: string; mask: boolean } {
  const tracks = new Set<"secrets" | "pii">(["secrets", "pii"]);
  let presidioUrl: string | undefined;
  let mask = false;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(`Score TypeSafe (Jev) against ficta's labelled fixtures

  ${ENV_API_KEY}=... pnpm --filter @serovaai/ficta bench:jev-detectors -- [--tracks=secrets,pii] [--presidio-url=http://127.0.0.1:5002] [--mask]

Reports precision/recall for the regex secret-shapes detector and for Jev on
bench/fixtures/secret-shapes-labelled.json, and for Jev (plus Presidio when a URL is given) on
bench/fixtures/pii-legal-identity.json. All inputs are synthetic.

--mask never sends a candidate's bytes: secret tokens are class-masked (a/A/0) with the regex
category as a hint, and PII spans are replaced by opaque placeholders so Jev judges from context
alone, as a post-redaction gateway call would. Responses cache under bench/.jev-cache/.`);
      process.exit(0);
    }
    if (arg.startsWith("--tracks=")) {
      tracks.clear();
      for (const track of arg.slice("--tracks=".length).split(",")) {
        if (track !== "secrets" && track !== "pii") throw new Error(`Unknown track ${track}`);
        tracks.add(track);
      }
    } else if (arg.startsWith("--presidio-url=")) presidioUrl = arg.slice("--presidio-url=".length);
    else if (arg === "--mask") mask = true;
    else throw new Error(`Unknown argument ${arg}; run with --help`);
  }
  return { tracks, presidioUrl, mask };
}
