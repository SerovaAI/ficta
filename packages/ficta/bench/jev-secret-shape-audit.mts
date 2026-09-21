import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { choice, noul } from "@typesafe-ai/sdk";
import { detectSecretShapes } from "../src/engine/plugins/secret-shapes/index.js";
import { createJevJudge, ENV_API_KEY, estimateUsd } from "./jev-judge.js";

/**
 * Label every `secret-shapes` candidate in a corpus with an independent Jev judgment so precision
 * per category can be measured instead of eyeballed. Runs against the repo's own tests by default
 * (synthetic values only); point `--corpus=<dir>` at a public checkout for real-world noise.
 *
 * Never run this against private source: every candidate line is sent to TypeSafe.
 */

interface Candidate {
  file: string;
  line: number;
  category: string;
  confidence: string;
  keyName: string;
  value: string;
  context: string;
}

interface Labelled extends Candidate {
  jevChoice: string;
  jevConfidence: number;
  jevCredential: number;
  agrees: boolean;
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
  ".md",
  ".txt",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".xml",
  ".html",
  ".css",
  ".sql",
  ".tf",
  ".example",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".turbo", ".output", ".jev-cache"]);
const MAX_FILE_BYTES = 512 * 1024;
const CONTEXT_LINES = 1;
const KEY_NAME = /([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*["'`]?[^\s"'`]*$/u;

const options = parseOptions(process.argv.slice(2));
const judge = createJevJudge();
if (!judge) {
  console.log(`Set ${ENV_API_KEY} to label candidates; exiting without a report.`);
  process.exit(0);
}

const files = await walk(options.corpus);
const candidates: Candidate[] = [];
for (const file of files) {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) continue;
  const lines = text.split("\n");
  for (const found of detectSecretShapes(text)) {
    const lineIndex = lines.findIndex((line) => line.includes(found.value));
    if (lineIndex === -1) continue;
    const line = lines[lineIndex] ?? "";
    const before = line.slice(0, line.indexOf(found.value));
    candidates.push({
      file: relative(options.corpus, file),
      line: lineIndex + 1,
      category: found.name,
      confidence: found.confidence ?? "unknown",
      keyName: KEY_NAME.exec(before)?.[1] ?? "",
      value: found.value,
      context: lines.slice(Math.max(0, lineIndex - CONTEXT_LINES), lineIndex + CONTEXT_LINES + 1).join("\n"),
    });
  }
  if (candidates.length >= options.limit) break;
}
const selected = candidates.slice(0, options.limit);
console.error(`[audit] ${files.length} files scanned, ${candidates.length} candidates, labelling ${selected.length}`);

const labelled: Labelled[] = [];
for (const candidate of selected) {
  const { answers } = await judge.ask(
    {
      token: candidate.value,
      key_name: candidate.keyName || null,
      detector_category: candidate.category,
      file_extension: extname(candidate.file) || null,
      surrounding_lines: candidate.context,
    },
    {
      kind: choice(
        "What is `token` in the context of `surrounding_lines`? Judge the token itself, not the rest of the line.",
        {
          credential:
            "A real API key, token, password, private key, or signing secret that would grant access if leaked.",
          placeholder: "A sample, dummy, or template value standing in for a credential in docs or tests.",
          identifier: "A program identifier, variable, function, class, enum, or i18n message key.",
          hash_or_digest: "A content hash, commit SHA, checksum, cache key, or build fingerprint.",
          path_or_url: "A filesystem path, URL, or path:line locator.",
          encoded_data:
            "Base64 or hex payload that is data rather than a credential, such as an image or a binary blob.",
          other: "None of the above.",
        },
      ),
      credential: noul(
        "Would a careful developer want `token` kept out of a chat transcript sent to a third-party AI service?",
        {
          true: "Leaking it could grant access or reveal a secret.",
          false: "It is harmless to share, such as public code, a placeholder, or a content hash.",
        },
      ),
    },
  );
  const jevChoice = answers.kind.choice;
  labelled.push({
    ...candidate,
    jevChoice,
    jevConfidence: round(answers.kind.confidence),
    jevCredential: round(answers.credential.noul),
    agrees: jevChoice === "credential" || jevChoice === "placeholder",
  });
}

const byCategory = new Map<string, { total: number; credential: number; placeholder: number; other: number }>();
for (const row of labelled) {
  const bucket = byCategory.get(row.category) ?? { total: 0, credential: 0, placeholder: 0, other: 0 };
  bucket.total += 1;
  if (row.jevChoice === "credential") bucket.credential += 1;
  else if (row.jevChoice === "placeholder") bucket.placeholder += 1;
  else bucket.other += 1;
  byCategory.set(row.category, bucket);
}

const summary = {
  corpus: options.corpus,
  model: judge.model,
  files: files.length,
  candidates: candidates.length,
  labelled: labelled.length,
  precisionByCategory: Object.fromEntries(
    [...byCategory].map(([category, bucket]) => [
      category,
      { ...bucket, precision: bucket.total === 0 ? 1 : round((bucket.credential + bucket.placeholder) / bucket.total) },
    ]),
  ),
  disagreements: labelled.filter((row) => !row.agrees).map(({ context: _context, ...row }) => row),
  usage: { ...judge.usage, estimatedUsd: Math.round(estimateUsd(judge.usage) * 10_000) / 10_000 },
};
console.log(JSON.stringify(summary, null, 2));

if (options.csv) {
  const header = "file,line,category,confidence,keyName,value,jevChoice,jevConfidence,jevCredential,agrees";
  const rows = labelled.map((row) =>
    [
      row.file,
      row.line,
      row.category,
      row.confidence,
      row.keyName,
      row.value,
      row.jevChoice,
      row.jevConfidence,
      row.jevCredential,
      row.agrees,
    ]
      .map(csvCell)
      .join(","),
  );
  await writeFile(options.csv, `${[header, ...rows].join("\n")}\n`);
  console.error(`[audit] wrote ${rows.length} rows to ${options.csv}`);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
      continue;
    }
    if (!entry.isFile() || (!TEXT_EXTENSIONS.has(extname(entry.name)) && !entry.name.startsWith(".env"))) continue;
    if ((await stat(full)).size > MAX_FILE_BYTES) continue;
    out.push(full);
  }
  return out;
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseOptions(args: string[]): { corpus: string; limit: number; csv?: string } {
  let corpus = new URL("../test/", import.meta.url).pathname;
  let limit = 200;
  let csv: string | undefined;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(`Label secret-shapes candidates with TypeSafe (Jev)

  ${ENV_API_KEY}=... pnpm --filter @serovaai/ficta bench:jev-secret-shapes -- [--corpus=<dir>] [--limit=200] [--csv=<file>]

Defaults to the package's own test/ directory (synthetic values). Every candidate line is sent to
TypeSafe, so only point --corpus at public source. Responses are cached under bench/.jev-cache/.`);
      process.exit(0);
    }
    if (arg.startsWith("--corpus=")) corpus = arg.slice("--corpus=".length);
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--csv=")) csv = arg.slice("--csv=".length);
    else throw new Error(`Unknown argument ${arg}; run with --help`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return { corpus, limit, csv };
}
