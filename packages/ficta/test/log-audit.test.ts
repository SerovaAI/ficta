import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditBeforeTraceRemoval,
  auditLeakCount,
  auditLogs,
  formatAuditReport,
  readAuditHistory,
  saveAuditReport,
} from "../src/log-audit.js";
import { pruneLogs } from "../src/log-retention.js";

const REGISTRY = "reg-Secret-7Qm2xVb9LpT4";
const DETECTED = "pat.example@example.com";
const QUOTED = 'pw"with\\escapes-9fK2mQ';
const SURROGATE = "[ficta:unrestored]";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ficta-log-audit-"));
  roots.push(root);
  return root;
}

interface Request {
  sent?: unknown;
  audit?: unknown;
  restored?: string;
}

/** One agent launch (capture unit) with numbered requests. */
function unit(root: string, pid: number, requests: Request[]): string {
  const dir = join(root, "agents", "claude", `2026-10-24T00-00-00-000Z-${pid}`);
  const run = join(dir, "runs", "run-2026-10-24T00-00-00-000Z");
  mkdirSync(run, { recursive: true });
  requests.forEach((request, i) => {
    const n = String(i + 1).padStart(4, "0");
    writeFileSync(join(run, `req-${n}.meta.json`), "{}");
    if (request.sent !== undefined) writeFileSync(join(run, `req-${n}.sent.json`), JSON.stringify(request.sent));
    if (request.audit !== undefined) writeFileSync(join(run, `audit-${n}.trace.json`), JSON.stringify(request.audit));
    if (request.restored !== undefined) writeFileSync(join(run, `res-${n}.restored.txt`), request.restored);
  });
  return dir;
}

function audit(values: { value: string; provenance: "permanent" | "detected"; name?: string }[]): unknown {
  return {
    version: 1,
    redactions: [
      {
        surface: "body",
        blocked: false,
        survivingCount: 0,
        redactedValues: values.map((v) => ({
          name: v.name ?? (v.provenance === "permanent" ? "API_TOKEN" : "email"),
          source: v.provenance === "permanent" ? ".env" : "presidio",
          value: v.value,
          surrogate: SURROGATE,
          provenance: v.provenance,
        })),
      },
    ],
    restore: { restored: [], withheldFromTools: [] },
  };
}

const message = (text: string) => ({ messages: [{ role: "user", content: [{ type: "text", text }] }] });

describe("ficta logs audit", () => {
  it("reports nothing when every protected value went out as a surrogate", async () => {
    const root = tempRoot();
    unit(root, 1, [
      { sent: message(`token ${SURROGATE}`), audit: audit([{ value: REGISTRY, provenance: "permanent" }]) },
    ]);
    const report = await auditLogs(root);
    expect(report.coverage).toMatchObject({ requests: 1, capturedBodies: 1, auditRecords: 1 });
    expect(report.findings).toEqual([]);
    expect(auditLeakCount(report)).toBe(0);
  });

  it("finds a protected value sent upstream, including one sent before it was first protected", async () => {
    const root = tempRoot();
    unit(root, 1, [
      { sent: message(`early ${DETECTED}`) },
      { sent: message(`token ${REGISTRY}`), audit: audit([{ value: REGISTRY, provenance: "permanent" }]) },
      { sent: message(`mail ${SURROGATE}`), audit: audit([{ value: DETECTED, provenance: "detected" }]) },
    ]);
    const report = await auditLogs(root);
    const egress = report.findings.filter((f) => f.kind === "egress");
    expect(egress).toHaveLength(2);
    expect(egress.find((f) => f.provenance === "permanent")).toMatchObject({
      name: "API_TOKEN",
      length: REGISTRY.length,
      locations: ["messages[].content[].text"],
    });
    expect(egress.find((f) => f.provenance === "detected")?.beforeFirstProtected).toBe(true);
    expect(auditLeakCount(report)).toBe(2);
  });

  it("finds a value that is escaped twice inside tool-call arguments", async () => {
    const root = tempRoot();
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ function: { name: "shell", arguments: JSON.stringify({ cmd: `deploy --as '${QUOTED}'` }) } }],
        },
      ],
    };
    unit(root, 1, [{ sent: body, audit: audit([{ value: QUOTED, provenance: "permanent" }]) }]);
    const [finding] = (await auditLogs(root)).findings;
    expect(finding).toMatchObject({
      kind: "egress",
      locations: ["messages[].tool_calls[].function.arguments(json).cmd"],
    });
  });

  it("counts a plain name inside a file path as preserved, and lists it", async () => {
    const root = tempRoot();
    const name = "eu-central-1-prod";
    unit(root, 1, [{ sent: message(`cd /srv/${name}/k8s`), audit: audit([{ value: name, provenance: "permanent" }]) }]);
    const report = await auditLogs(root);
    expect(report.findings).toEqual([]);
    expect(report.pathPreserved).toBe(1);
    expect(report.pathSightings).toEqual([
      expect.objectContaining({ length: name.length, requests: ["runs/run-2026-10-24T00-00-00-000Z/req-0001"] }),
    ]);
  });

  it("reports a credential-looking value inside a path as a leak, since redaction never preserves one", async () => {
    const root = tempRoot();
    const hash = "9f3b9566f64e7a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c";
    unit(root, 1, [
      { sent: message(`see /tmp/${hash}/vite.log`), audit: audit([{ value: hash, provenance: "detected" }]) },
    ]);
    const report = await auditLogs(root);
    expect(report.findings.map((finding) => finding.kind)).toEqual(["egress"]);
    expect(report.pathPreserved).toBe(0);
  });

  it("checks each launch only against the values that launch protected", async () => {
    const root = tempRoot();
    unit(root, 1, [
      { sent: message(`token ${SURROGATE}`), audit: audit([{ value: REGISTRY, provenance: "permanent" }]) },
    ]);
    // Another project, where the value is not registered: sending it is not a leak of this launch.
    unit(root, 2, [{ sent: message(`token ${REGISTRY}`), audit: audit([]) }]);
    expect((await auditLogs(root)).findings).toEqual([]);
  });

  it("finds a registry value restored into a streamed tool call, split across deltas", async () => {
    const root = tempRoot();
    const half = REGISTRY.length / 2;
    const sse = [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", input: {} } },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: `{"cmd":"curl -H ${REGISTRY.slice(0, half)}` },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: `${REGISTRY.slice(half)}"}` },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `prose may show ${DETECTED}` } },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    unit(root, 1, [
      {
        sent: message(`hi ${SURROGATE}`),
        audit: audit([
          { value: REGISTRY, provenance: "permanent" },
          { value: DETECTED, provenance: "detected" },
        ]),
        restored: sse,
      },
    ]);
    const report = await auditLogs(root);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: "tool-restore",
      provenance: "permanent",
      requests: ["runs/run-2026-10-24T00-00-00-000Z/res-0001"],
      locations: ["content_block[1].input_json_delta"],
    });
  });

  it("finds a registry value in a buffered Responses custom tool call", async () => {
    const root = tempRoot();
    const restored = JSON.stringify({
      output: [{ type: "custom_tool_call", name: "apply_patch", input: `+${REGISTRY}` }],
    });
    unit(root, 1, [
      { sent: message(SURROGATE), audit: audit([{ value: REGISTRY, provenance: "permanent" }]), restored },
    ]);
    expect((await auditLogs(root)).findings).toMatchObject([
      { kind: "tool-restore", locations: ["output[0].custom_tool_call.input"] },
    ]);
  });

  it("flags an unreplaced secret shape for review without counting it as a leak", async () => {
    const root = tempRoot();
    const token = ["gh", "p_"].join("") + "Zx9Qw3Er7Ty1Ui5Op2As6Df4Gh8Jk0LmNbVc".slice(0, 36);
    unit(root, 1, [{ sent: message(`export GITHUB_TOKEN=${token}`) }]);
    const report = await auditLogs(root);
    expect(report.findings).toMatchObject([{ kind: "unprotected-shape", length: token.length }]);
    expect(auditLeakCount(report)).toBe(0);
  });

  it("never prints a raw value", async () => {
    const root = tempRoot();
    unit(root, 1, [
      {
        sent: message(`token ${REGISTRY} and ${QUOTED}`),
        audit: audit([
          { value: REGISTRY, provenance: "permanent" },
          { value: QUOTED, provenance: "permanent" },
        ]),
        restored: JSON.stringify({ output: [{ type: "function_call", arguments: JSON.stringify({ cmd: REGISTRY }) }] }),
      },
    ]);
    const report = await auditLogs(root);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const output of [formatAuditReport(report), JSON.stringify(report)]) {
      expect(output).not.toContain(REGISTRY);
      expect(output).not.toContain("9fK2mQ");
    }
  });

  it("says when there is nothing to audit", async () => {
    const root = tempRoot();
    unit(root, 1, [{}]);
    expect(formatAuditReport(await auditLogs(root))).toContain("nothing to audit");
  });

  it("does not flag Claude Code's device id in metadata.user_id, but still flags the same id elsewhere", async () => {
    const root = tempRoot();
    const device = [
      "5f3c9a1e",
      "7b2d4f60",
      "8e1a3c5b",
      "9d7f2e4a",
      "6c0b8d1f",
      "3a5e7c9b",
      "2f4d6a8c",
      "1e3b5d7f",
    ].join("");
    const userId = JSON.stringify({
      device_id: device,
      account_uuid: "",
      session_id: "a71e04c2-9d3b-4f58-8c26-5e0f9b1d7a43",
    });
    unit(root, 1, [
      { sent: { metadata: { user_id: userId }, messages: [{ role: "user", content: "hi" }] }, audit: audit([]) },
    ]);
    expect((await auditLogs(root)).findings).toEqual([]);

    const other = tempRoot();
    unit(other, 1, [
      {
        sent: { metadata: { user_id: userId }, messages: [{ role: "user", content: `id ${device}` }] },
        audit: audit([]),
      },
    ]);
    const findings = (await auditLogs(other)).findings;
    expect(findings.map((finding) => [finding.kind, finding.locations])).toEqual([
      ["unprotected-shape", ["messages[].content"]],
    ]);
  });

  it("saves reports and totals them, counting a unit audited twice once", async () => {
    const root = tempRoot();
    unit(root, 1, [
      { sent: message(`token ${REGISTRY}`), audit: audit([{ value: REGISTRY, provenance: "permanent" }]) },
    ]);
    unit(root, 2, [
      { sent: message("nothing here"), audit: audit([]) },
      { sent: message("still nothing"), audit: audit([]) },
    ]);
    const first = await auditLogs(root);
    await saveAuditReport(root, first);
    await saveAuditReport(root, { ...(await auditLogs(root)), at: "2099-01-01T00:00:00.000Z" });

    const history = await readAuditHistory(root);
    expect(history).toMatchObject({ reports: 2, units: 2, requestsAudited: 3, leakFindings: 1 });
    expect(history.lastAt).toBe("2099-01-01T00:00:00.000Z");
    // The audits dir is not a capture unit and does not disturb later audits.
    expect((await auditLogs(root)).coverage.units).toBe(2);
  });

  it("audits units just before pruning deletes their raw traces", async () => {
    const root = tempRoot();
    const dir = unit(root, 999_999, [
      { sent: message(`token ${REGISTRY}`), audit: audit([{ value: REGISTRY, provenance: "permanent" }]) },
    ]);
    const result = await pruneLogs(
      root,
      { traceMaxAgeMs: 0 },
      { now: Date.now() + 60_000, isPidAlive: () => false, beforeTraceRemoval: auditBeforeTraceRemoval(root) },
    );
    expect(result.removedTraceFiles).toBeGreaterThan(0);
    expect(existsSync(join(dir, "runs", "run-2026-10-24T00-00-00-000Z", "req-0001.sent.json"))).toBe(false);
    const history = await readAuditHistory(root);
    expect(history).toMatchObject({ reports: 1, requestsAudited: 1, leakFindings: 1 });
  });
});
