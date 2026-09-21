import type { ProtectionPreviewFinding } from "@serovaai/ficta-protocol";
import { choice, noul, type Questions, type SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  SECOND_OPINION_KINDS,
  type SecondOpinion,
  type SecondOpinionAvailability,
  type SecondOpinionFindingLabel,
  type SecondOpinionKind,
  type SecondOpinionLine,
} from "./second-opinion";
import type { InstanceSettings } from "./storage/types";

/**
 * Optional pre-send second opinion from TypeSafe (Jev). Exists only when the operator sets a
 * `TYPESAFE_API_KEY`; an admin then switches it on in Admin settings, unless
 * `FICTA_GATEWAY_SECOND_OPINION=on|off` pins it from the environment.
 *
 * Privacy contract (see apps/gateway/docs/threat-model-pii.md, "Optional second-opinion service"):
 * - Registered values never leave: every `registry` finding is replaced by its surrogate before any
 *   text is sent. Detected and user-selected spans are sent as text, because context-only
 *   judgement of a placeholder does not work.
 * - The result is advisory. It never changes what the proxy redacts; it labels detected findings
 *   and flags lines the detectors may have missed for the user to select.
 * - Fail open: every error, timeout, or oversize input yields a non-`ok` status and the review
 *   proceeds exactly as it would without this feature.
 */

const ENV_ENABLED = "FICTA_GATEWAY_SECOND_OPINION";
const ENV_API_KEY = "TYPESAFE_API_KEY";
const ENV_MODEL = "FICTA_GATEWAY_SECOND_OPINION_MODEL";
const ENV_TIMEOUT = "FICTA_GATEWAY_SECOND_OPINION_TIMEOUT_MS";
/** Pinned: thresholds below were evaluated against this model; `jev-latest` may move. */
const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 4_000;

export const SECOND_OPINION_LINES_MAX = 200;
export const SECOND_OPINION_BYTES_MAX = 24 * 1024;
export const SECOND_OPINION_FINDINGS_MAX = 60;
/** A line is flagged for review when either Noul reaches this probability. */
export const SECOND_OPINION_LINE_THRESHOLD = 0.7;
/** A detected finding gets a kind label only when the Choice is this confident. */
export const SECOND_OPINION_LABEL_CONFIDENCE_MIN = 0.6;

export interface SecondOpinionConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface SecondOpinionDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Secret-free availability for the admin UI. The API key decides whether the feature exists on this
 * deployment; `FICTA_GATEWAY_SECOND_OPINION=on|off` pins it either way, and when unset the admin
 * instance setting decides (default off).
 */
export function secondOpinionAvailability(env: NodeJS.ProcessEnv = process.env): SecondOpinionAvailability {
  const available = Boolean(env[ENV_API_KEY]?.trim());
  const flag = env[ENV_ENABLED]?.trim().toLowerCase();
  const pinned = flag === "on" ? "on" : flag === "off" ? "off" : undefined;
  return pinned ? { available, pinned } : { available };
}

/** Resolve the effective configuration for one request; `null` means do not call the service. */
export function secondOpinionConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<InstanceSettings, "secondOpinionEnabled"> = {},
): SecondOpinionConfig | null {
  const { available, pinned } = secondOpinionAvailability(env);
  if (!available) return null;
  const enabled = pinned ? pinned === "on" : settings.secondOpinionEnabled === true;
  if (!enabled) return null;
  const apiKey = env[ENV_API_KEY]!.trim();
  const model = env[ENV_MODEL]?.trim() || DEFAULT_MODEL;
  const timeoutRaw = Number(env[ENV_TIMEOUT]?.trim() || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;
  return { apiKey, model, timeoutMs };
}

export interface LineRange {
  line: number;
  start: number;
  end: number;
}

/** Line ranges over the original text, excluding the newline itself. */
export function lineRanges(text: string): LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;
  let line = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    ranges.push({ line, start, end });
    if (newline === -1) return ranges;
    start = newline + 1;
    line += 1;
  }
}

/**
 * The text of `[start, end)` with every finding accepted by `include` replaced by its surrogate.
 * A finding that crosses the range boundary contributes its surrogate for the overlapped part, so a
 * line never leaks a fragment of a protected value.
 */
export function substituteSpans(
  text: string,
  start: number,
  end: number,
  findings: readonly ProtectionPreviewFinding[],
  include: (finding: ProtectionPreviewFinding) => boolean,
): string {
  const overlapping = findings
    .filter((finding) => include(finding) && finding.start < end && finding.end > start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = start;
  for (const finding of overlapping) {
    if (finding.start < cursor) continue; // nested or overlapping: the earlier, longer span already covers it
    out += text.slice(cursor, finding.start) + finding.surrogate;
    cursor = Math.min(end, finding.end);
  }
  return out + text.slice(cursor, end);
}

const isRegistry = (finding: ProtectionPreviewFinding) => finding.origin === "registry";
const isAny = () => true;

const KIND_CRITERIA: Record<SecondOpinionKind, string> = {
  credential: "A live API key, token, password, private key, or signing secret that grants access if leaked.",
  placeholder: "A sample, dummy, or template value standing in for a credential in docs or tests.",
  identifier: "A program identifier, variable, property chain, file name, or i18n message key.",
  hash_or_digest: "A content hash, commit SHA, checksum, or image digest.",
  path_or_url: "A filesystem path or a URL without a literal password.",
  encoded_data: "Base64 or hex payload that is data, such as an image.",
  person: "The name of a specific individual.",
  organization: "The name of a specific company, firm, trust, or institution, including a short alias of one.",
  role_or_legal_term: "A contractual role or legal concept such as Borrower, Security Interest, or Supreme Court.",
  commercial_fact: "An amount, rate, duration, deadline, project name, or other business term.",
  other: "None of the above.",
};

interface Candidate {
  finding: ProtectionPreviewFinding;
  span: string;
  line: string;
}

interface Prepared {
  state: { lines: Array<{ id: number; text: string }>; candidates: Array<{ id: number; span: string; line: string }> };
  questions: Questions;
  judgedLines: LineRange[];
  candidates: Candidate[];
}

/** Build the single request. Exported for tests; contains no network code. */
export function prepareSecondOpinion(
  text: string,
  findings: readonly ProtectionPreviewFinding[],
): Prepared | { skipped: string } {
  const ranges = lineRanges(text);
  if (ranges.length > SECOND_OPINION_LINES_MAX) return { skipped: "too_many_lines" };
  if (new TextEncoder().encode(text).byteLength > SECOND_OPINION_BYTES_MAX) return { skipped: "too_large" };
  if (findings.some((finding) => finding.surrogate.includes("\n"))) return { skipped: "unsupported_surrogate" };

  // Line view: everything already protected is a placeholder, so "not yet protected" is literal.
  const judgedLines = ranges.filter((range) => text.slice(range.start, range.end).trim().length > 0);
  const lines = judgedLines.map((range) => ({
    id: range.line,
    text: substituteSpans(text, range.start, range.end, findings, isAny),
  }));

  // Candidate view: detected spans in their line, with registry values (only) already substituted.
  const detected = findings
    .filter((finding) => finding.origin === "detected")
    .sort((a, b) => rankConfidence(a) - rankConfidence(b) || a.start - b.start)
    .slice(0, SECOND_OPINION_FINDINGS_MAX);
  const candidates: Candidate[] = detected.map((finding) => {
    const range = ranges.find((item) => finding.start >= item.start && finding.start <= item.end) ?? ranges[0]!;
    return {
      finding,
      span: text.slice(finding.start, finding.end),
      line: substituteSpans(text, range.start, range.end, findings, isRegistry),
    };
  });

  const questions: Questions = {};
  lines.forEach((line, index) => {
    questions[`p${line.id}`] = noul(
      `Does the text of \`lines[${index}].text\` name a specific real-world person, company, or organisation, or give one of their personal identifiers such as an ID number, email address, birth date, registration number, or home address? Text already replaced by a FICTA_ placeholder does not count.`,
      {
        true: "It names a person or organisation, or gives one of their identifiers, in plain text.",
        false: "It contains only placeholders, role words, legal terms, amounts, dates, or general prose.",
      },
    );
    questions[`c${line.id}`] = noul(
      `Does the text of \`lines[${index}].text\` state a specific amount of money, interest rate, percentage, deadline, contract period, project name, or account reference that belongs to a named party or deal?`,
      {
        true: "It states a concrete commercial term of a specific deal or party.",
        false: "It states no such term, or only a generic figure with no party or deal attached.",
      },
    );
  });
  candidates.forEach((candidate, index) => {
    questions[`f${index}`] = choice(
      `What is \`candidates[${index}].span\` as it appears in \`candidates[${index}].line\`? Judge the span itself, not the rest of the line.`,
      KIND_CRITERIA,
    );
  });

  return {
    state: {
      lines,
      candidates: candidates.map((candidate, id) => ({ id, span: candidate.span, line: candidate.line })),
    },
    questions,
    judgedLines,
    candidates,
  };
}

/** Never throws: any failure becomes `unavailable` and the review proceeds without a second opinion. */
export async function assessProtectionPreview(
  input: { text: string; findings: readonly ProtectionPreviewFinding[] },
  config: SecondOpinionConfig,
  deps: SecondOpinionDeps = {},
): Promise<SecondOpinion> {
  const prepared = prepareSecondOpinion(input.text, input.findings);
  if ("skipped" in prepared) return { status: "skipped", reason: prepared.skipped, findings: [], lines: [] };
  if (Object.keys(prepared.questions).length === 0)
    return { status: "ok", model: config.model, findings: [], lines: [] };

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    logLevel: "error",
    retry: { maxRetries: 0 },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  let result: SystemOneResult<Questions>;
  try {
    result = await client.systemOne({ state: prepared.state, questions: prepared.questions });
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : "error";
    console.warn(`Second opinion unavailable (${reason}).`);
    return { status: "unavailable", reason, findings: [], lines: [] };
  }
  // The SDK types the response but does not validate it; a non-JSON or unexpected body must fail open.
  if (!result || typeof result !== "object" || !result.answers || typeof result.answers !== "object") {
    console.warn("Second opinion unavailable (malformed response).");
    return { status: "unavailable", reason: "malformed", findings: [], lines: [] };
  }

  const lines: SecondOpinionLine[] = [];
  for (const range of prepared.judgedLines) {
    const party = readNoul(result.answers[`p${range.line}`]);
    const fact = readNoul(result.answers[`c${range.line}`]);
    if (party >= SECOND_OPINION_LINE_THRESHOLD || fact >= SECOND_OPINION_LINE_THRESHOLD) {
      lines.push({ line: range.line, start: range.start, end: range.end, party, fact });
    }
  }
  const findings: SecondOpinionFindingLabel[] = [];
  prepared.candidates.forEach((candidate, index) => {
    const answer = result.answers[`f${index}`];
    if (!answer || answer.type !== "choice") return;
    if (answer.confidence < SECOND_OPINION_LABEL_CONFIDENCE_MIN) return;
    if (!SECOND_OPINION_KINDS.includes(answer.choice as SecondOpinionKind)) return;
    findings.push({
      start: candidate.finding.start,
      end: candidate.finding.end,
      kind: answer.choice as SecondOpinionKind,
      confidence: round(answer.confidence),
    });
  });

  const model = typeof result.model === "string" ? result.model : config.model;
  console.debug(
    `Second opinion: ${model}, ${result.usage?.input_tokens ?? "?"} input tokens, ${now() - startedAt} ms, ${lines.length} flagged line(s).`,
  );
  return { status: "ok", model, findings, lines };
}

function readNoul(answer: SystemOneResult<Questions>["answers"][string] | undefined): number {
  return answer?.type === "noul" ? round(answer.noul) : 0;
}

function rankConfidence(finding: ProtectionPreviewFinding): number {
  return finding.confidence === "probabilistic" ? 0 : finding.confidence === "high" ? 1 : 2;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
