import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { detectSecretShapes } from "@serovaai/ficta-engine";
import { type LogUnit, scanLogUnits } from "./log-retention.js";

/**
 * `ficta logs audit`: replay the raw-value captures under the log root and check what actually
 * reached the provider and the agent. Each capture unit is one proxy process (one agent launch, or
 * one Gateway run), so it is checked only against the values that unit itself protected: a value
 * registered in one project is not a leak in another project's session, whose registry differs.
 *
 * The report never carries a raw value. A value is identified by a SHA-256 prefix, its length, and
 * the detector/registry labels the audit sidecar recorded for it.
 */

export type AuditFindingKind = "egress" | "tool-restore" | "unprotected-shape";

export interface AuditFinding {
  /** `egress`: a protected value in a body sent upstream. `tool-restore`: a registry value inside
   *  tool-call input sent to the client. `unprotected-shape`: a secret-shaped string sent upstream
   *  that nothing replaced (a detector miss or a false positive; for review, not a leak). */
  kind: AuditFindingKind;
  /** Capture unit, relative to the log root. */
  unit: string;
  sha256: string;
  length: number;
  name: string;
  source?: string;
  provenance?: string;
  /** Capture files the value was found in, relative to the unit. */
  requests: string[];
  /** Body locations, e.g. `messages[].content[].text`; `(json)` marks JSON text inside a string. */
  locations: string[];
  /** Egress only: some sightings precede the first request that protected the value. */
  beforeFirstProtected?: boolean;
}

export interface AuditCoverage {
  units: number;
  requests: number;
  capturedBodies: number;
  auditRecords: number;
}

export interface LogAuditReport {
  root: string;
  coverage: AuditCoverage;
  byGroup: Record<string, AuditCoverage>;
  /** Requests whose audit records a fail-closed block or a value surviving redaction. */
  leakGateEvents: number;
  /** Sightings of a protected value inside a filesystem path, which redaction preserves by design. */
  pathPreserved: number;
  findings: AuditFinding[];
}

/** Leaks are egress and tool-restore findings; unprotected shapes only need review. */
export function auditLeakCount(report: LogAuditReport): number {
  return report.findings.filter((finding) => finding.kind !== "unprotected-shape").length;
}

const SURROGATE = /FICTA_[A-Za-z0-9_]{6,}/g;
const MIN_VALUE_LENGTH = 6;
/** Provider-opaque blobs sent back verbatim (thinking signatures, encrypted reasoning). */
const OPAQUE_KEYS = new Set(["signature", "encrypted_content"]);

interface Protected {
  name: string;
  source?: string;
  provenance?: string;
  firstSeen: string;
}

interface AuditValue {
  value?: unknown;
  name?: string;
  source?: string;
  provenance?: string;
}

interface AuditRecord {
  redactions?: {
    blocked?: boolean;
    survivingCount?: number;
    redactedValues?: AuditValue[];
    survivingValues?: AuditValue[];
  }[];
  restore?: { restored?: AuditValue[]; withheldFromTools?: AuditValue[] };
}

export async function auditLogs(root: string): Promise<LogAuditReport> {
  const report: LogAuditReport = {
    root,
    coverage: emptyCoverage(),
    byGroup: {},
    leakGateEvents: 0,
    pathPreserved: 0,
    findings: [],
  };
  for (const unit of await scanLogUnits(root)) {
    const group = (report.byGroup[unit.group] ??= emptyCoverage());
    const counts = coverageOf(unit);
    for (const target of [group, report.coverage]) {
      target.units += 1;
      target.requests += counts.requests;
      target.capturedBodies += counts.capturedBodies;
      target.auditRecords += counts.auditRecords;
    }
    if (counts.capturedBodies > 0 || counts.auditRecords > 0) await auditUnit(root, unit, report);
  }
  return report;
}

function emptyCoverage(): AuditCoverage {
  return { units: 0, requests: 0, capturedBodies: 0, auditRecords: 0 };
}

function coverageOf(unit: LogUnit): AuditCoverage {
  const count = (re: RegExp) => unit.files.filter((file) => re.test(basename(file.path))).length;
  return {
    units: 1,
    requests: count(/^req-\d+\.meta\.json$/),
    capturedBodies: count(/^req-\d+\.sent\.json$/),
    auditRecords: count(/^audit-\d+\.trace\.json$/),
  };
}

async function auditUnit(root: string, unit: LogUnit, report: LogAuditReport): Promise<void> {
  const unitName = relative(root, unit.path) || ".";
  // `runs/run-…/req-0012`: run names are timestamps and numbers are padded, so these sort in order.
  const requestKey = (path: string) =>
    `${relative(unit.path, dirname(path))}/${basename(path)
      .replace(/^(?:audit|res)-/, "req-")
      .replace(/\..*$/, "")}`;
  const files = (re: RegExp) =>
    unit.files
      .map((file) => file.path)
      .filter((path) => re.test(basename(path)))
      .sort((a, b) => requestKey(a).localeCompare(requestKey(b)));

  const catalogue = new Map<string, Protected>();
  for (const path of files(/^audit-\d+\.trace\.json$/)) {
    const record = await readJson<AuditRecord>(path);
    if (!record) continue;
    if (record.redactions?.some((r) => r.blocked || (r.survivingCount ?? 0) > 0)) report.leakGateEvents += 1;
    const values = [
      ...(record.redactions ?? []).flatMap((r) => [...(r.redactedValues ?? []), ...(r.survivingValues ?? [])]),
      ...(record.restore?.restored ?? []),
      ...(record.restore?.withheldFromTools ?? []),
    ];
    for (const entry of values) {
      if (typeof entry.value !== "string" || entry.value.length < MIN_VALUE_LENGTH) continue;
      const known = catalogue.get(entry.value);
      if (known) {
        if (entry.provenance === "permanent") known.provenance = "permanent"; // registry authority wins
        continue;
      }
      catalogue.set(entry.value, {
        name: entry.name ?? "unknown",
        source: entry.source,
        provenance: entry.provenance,
        firstSeen: requestKey(path),
      });
    }
  }

  const egress = new Map<string, AuditFinding>();
  const shapes = new Map<string, AuditFinding>();
  const scanned = new Set<string>();
  for (const path of files(/^req-\d+\.sent\.json$/)) {
    const body = await readFile(path, "utf8").catch(() => undefined);
    if (body === undefined) continue;
    const request = requestKey(path);
    for (const leaf of bodyLeaves(body)) {
      const text = leaf.text.replace(SURROGATE, (token) => " ".repeat(token.length));
      for (const [value, meta] of catalogue) {
        const at = occurrences(text, value);
        if (at.length === 0) continue;
        if (at.every((index) => insidePath(text, index, value.length))) {
          report.pathPreserved += 1;
          continue;
        }
        const finding = upsert(egress, value, () => ({
          kind: "egress",
          unit: unitName,
          ...identify(value),
          name: meta.name,
          source: meta.source,
          provenance: meta.provenance,
          requests: [],
          locations: [],
        }));
        note(finding, request, leaf.location);
        if (request < meta.firstSeen) finding.beforeFirstProtected = true;
      }
      if (OPAQUE_KEYS.has(leaf.key ?? "") || leaf.text.length < MIN_VALUE_LENGTH) continue;
      // Conversation history repeats in every request; scan each distinct string once per unit.
      const digest = sha256(leaf.text);
      if (scanned.has(digest)) continue;
      scanned.add(digest);
      // Detect on the text as sent: blanking surrogates out would change what surrounds a name and
      // make the detector see shapes the engine never saw.
      for (const hit of detectSecretShapes(leaf.text)) {
        if (catalogue.has(hit.value) || new RegExp(`^${SURROGATE.source}$`).test(hit.value)) continue;
        const index = leaf.text.indexOf(hit.value);
        if (index >= 0 && insidePath(leaf.text, index, hit.value.length)) continue;
        const finding = upsert(shapes, hit.value, () => ({
          kind: "unprotected-shape",
          unit: unitName,
          ...identify(hit.value),
          name: hit.name,
          source: hit.source,
          requests: [],
          locations: [],
        }));
        note(finding, request, leaf.location);
      }
    }
  }

  const tool = new Map<string, AuditFinding>();
  const registry = [...catalogue].filter(([, meta]) => meta.provenance === "permanent");
  if (registry.length > 0) {
    for (const path of files(/^res-\d+\.restored\.txt$/)) {
      const body = await readFile(path, "utf8").catch(() => undefined);
      if (body === undefined) continue;
      for (const [location, text] of toolInputTexts(body)) {
        for (const [value, meta] of registry) {
          if (!text.includes(value) && !text.includes(jsonEscape(value))) continue;
          const finding = upsert(tool, value, () => ({
            kind: "tool-restore",
            unit: unitName,
            ...identify(value),
            name: meta.name,
            source: meta.source,
            provenance: meta.provenance,
            requests: [],
            locations: [],
          }));
          note(finding, requestKey(path).replace(/req-(\d+)$/, "res-$1"), location);
        }
      }
    }
  }
  report.findings.push(...egress.values(), ...tool.values(), ...shapes.values());
}

interface BodyLeaf {
  text: string;
  location: string;
  key?: string;
}

/**
 * Every string in a captured body with its location. A string that is itself a JSON object or array
 * (OpenAI tool-call `arguments`) is walked too, so a value escaped twice there is still found as
 * itself, never as an escaped spelling that could also be a different string.
 */
function bodyLeaves(body: string): BodyLeaf[] {
  const leaves: BodyLeaf[] = [];
  const walk = (value: unknown, location: string, key?: string): void => {
    if (typeof value === "string") {
      leaves.push({ text: value, location: location || "(body)", key });
      const nested = parseJsonText(value);
      if (nested !== undefined) walk(nested, `${location}(json)`, key);
    } else if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${location}[]`, key);
    } else if (value && typeof value === "object") {
      for (const [k, entry] of Object.entries(value)) {
        leaves.push({ text: k, location: `${location}${location ? "." : ""}${k}(key)`, key: k });
        walk(entry, `${location}${location ? "." : ""}${k}`, k);
      }
    }
  };
  const parsed = parseJson(body);
  if (parsed === undefined) leaves.push({ text: body, location: "(raw body)" });
  else walk(parsed, "");
  return leaves;
}

/**
 * Tool-call input in a client-bound response, buffered or SSE, keyed by where it came from.
 * Streamed fragments are concatenated per tool call so a value split across deltas is whole.
 */
function toolInputTexts(body: string): Map<string, string> {
  const texts = new Map<string, string>();
  const add = (key: string, text: unknown) => {
    if (typeof text === "string" && text) texts.set(key, (texts.get(key) ?? "") + text);
  };
  const items = (output: unknown, key: string) => {
    if (!Array.isArray(output)) return;
    output.forEach((item, i) => toolItem(item, `${key}[${i}]`));
  };
  const toolItem = (item: unknown, key: string) => {
    if (!isRecord(item)) return;
    if (item.type === "tool_use") add(`${key}.tool_use.input`, JSON.stringify(item.input ?? null));
    if (item.type === "function_call") add(`${key}.function_call.arguments`, item.arguments);
    if (item.type === "custom_tool_call") add(`${key}.custom_tool_call.input`, item.input);
    if (item.type === "local_shell_call") add(`${key}.local_shell_call.action`, JSON.stringify(item.action ?? null));
  };
  const visit = (data: unknown) => {
    if (!isRecord(data)) return;
    // Anthropic: content[] / message.content[] / content_block, and input_json_delta fragments.
    items(data.content, "content");
    if (isRecord(data.message)) items(data.message.content, "message.content");
    toolItem(data.content_block, `content_block[${String(data.index)}]`);
    if (isRecord(data.delta) && data.delta.type === "input_json_delta") {
      add(`content_block[${String(data.index)}].input_json_delta`, data.delta.partial_json);
    }
    // OpenAI Responses: output items (buffered, response.*, output_item.*) and input/arguments events.
    items(data.output, "output");
    if (isRecord(data.response)) items(data.response.output, "response.output");
    toolItem(data.item, `item[${String(data.item_id ?? data.output_index)}]`);
    const id = String(data.item_id ?? data.output_index);
    if (data.type === "response.function_call_arguments.delta") add(`item[${id}].arguments.delta`, data.delta);
    if (data.type === "response.function_call_arguments.done") add(`item[${id}].arguments.done`, data.arguments);
    if (data.type === "response.custom_tool_call_input.delta") add(`item[${id}].input.delta`, data.delta);
    if (data.type === "response.custom_tool_call_input.done") add(`item[${id}].input.done`, data.input);
    // OpenAI Chat: message.tool_calls (buffered) and delta.tool_calls (streamed).
    if (Array.isArray(data.choices)) {
      data.choices.forEach((choice, c) => {
        if (!isRecord(choice)) return;
        for (const source of [choice.message, choice.delta]) {
          if (!isRecord(source) || !Array.isArray(source.tool_calls)) continue;
          source.tool_calls.forEach((call, t) => {
            if (!isRecord(call)) return;
            const key = `choices[${String(choice.index ?? c)}].tool_calls[${String(call.index ?? t)}]`;
            if (isRecord(call.function)) add(`${key}.function.arguments`, call.function.arguments);
            if (isRecord(call.custom)) add(`${key}.custom.input`, call.custom.input);
          });
        }
      });
    }
  };
  if (/^(?:event|data):/m.test(body)) {
    for (const line of body.split("\n")) {
      if (line.startsWith("data:")) visit(parseJson(line.slice(5).trim()));
    }
  } else {
    visit(parseJson(body));
  }
  return texts;
}

/** Whether the match at `index` is part of a filesystem path, which redaction preserves. */
function insidePath(text: string, index: number, length: number): boolean {
  const value = text.slice(index, index + length);
  return /^(?:~|\.{0,2})\//.test(value) || text[index - 1] === "/" || text[index + length] === "/";
}

function occurrences(text: string, value: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) found.push(i);
  return found;
}

function upsert(map: Map<string, AuditFinding>, value: string, create: () => AuditFinding): AuditFinding {
  let finding = map.get(value);
  if (!finding) map.set(value, (finding = create()));
  return finding;
}

function note(finding: AuditFinding, request: string, location: string): void {
  if (!finding.requests.includes(request)) finding.requests.push(request);
  if (!finding.locations.includes(location)) finding.locations.push(location);
}

function identify(value: string): { sha256: string; length: number } {
  return { sha256: sha256(value).slice(0, 12), length: value.length };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonText(text: string): unknown {
  const first = text.trimStart()[0];
  return first === "{" || first === "[" ? parseJson(text) : undefined;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : (parseJson(text) as T | undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const KIND_TITLES: Record<AuditFindingKind, string> = {
  egress: "Protected values sent to the provider",
  "tool-restore": "Registry values restored into tool calls (expected only with restore_into_tools = all)",
  "unprotected-shape": "Secret-shaped strings sent unreplaced (review: detector miss or false positive)",
};

/** Human-readable report. Carries no raw values: only hashes, lengths, labels, and file names. */
export function formatAuditReport(report: LogAuditReport): string {
  const { coverage } = report;
  const lines = [`ficta logs audit: ${report.root}`];
  const width = Math.max(0, ...Object.keys(report.byGroup).map((name) => name.length));
  for (const [name, group] of Object.entries(report.byGroup).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `  ${name.padEnd(width)}  ${group.requests} request(s), ${group.capturedBodies} with bodies, ${group.auditRecords} with audit records`,
    );
  }
  if (coverage.capturedBodies === 0) {
    lines.push("nothing to audit: no captured bodies (launch with FICTA_DEV_TRACE=1 or [logging] dev_trace = true)");
    return `${lines.join("\n")}\n`;
  }
  const uncaptured = coverage.requests - coverage.capturedBodies;
  if (uncaptured > 0) lines.push(`! ${uncaptured} request(s) have no captured body and were not audited`);
  if (coverage.auditRecords === 0) {
    lines.push("! no audit records: only the secret-shape scan ran (FICTA_TRACE_AUDIT=1 records protected values)");
  }
  lines.push(`leak gate: ${report.leakGateEvents} request(s) blocked or with values surviving redaction`);
  if (report.pathPreserved > 0) {
    lines.push(
      `paths: ${report.pathPreserved} sighting(s) of a protected value inside a file path (preserved by design)`,
    );
  }
  for (const kind of ["egress", "tool-restore", "unprotected-shape"] as const) {
    const findings = report.findings.filter((finding) => finding.kind === kind);
    lines.push("", `${KIND_TITLES[kind]}: ${findings.length}`);
    for (const finding of findings) {
      const labels = [finding.name, finding.source, finding.provenance].filter(Boolean).join(", ");
      const early = finding.beforeFirstProtected ? ", some before it was first protected" : "";
      lines.push(
        `  sha256:${finding.sha256} len=${finding.length} (${labels}) in ${finding.requests.length} request(s)${early}`,
        `    ${finding.unit}/${finding.requests[0] ?? ""}`,
        `    at ${finding.locations.slice(0, 3).join(", ")}${finding.locations.length > 3 ? ", …" : ""}`,
      );
    }
  }
  const leaks = auditLeakCount(report);
  lines.push("", leaks === 0 ? "no leaks found in the captured requests" : `${leaks} leak finding(s)`);
  return `${lines.join("\n")}\n`;
}
