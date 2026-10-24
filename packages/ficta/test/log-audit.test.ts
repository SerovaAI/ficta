import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditLeakCount, auditLogs, formatAuditReport } from "../src/log-audit.js";

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

  it("counts a value inside a file path as preserved, not leaked", async () => {
    const root = tempRoot();
    const hash = "9f3b9566f64e7a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c";
    unit(root, 1, [
      { sent: message(`see /tmp/${hash}/vite.log`), audit: audit([{ value: hash, provenance: "detected" }]) },
    ]);
    const report = await auditLogs(root);
    expect(report.findings).toEqual([]);
    expect(report.pathPreserved).toBe(1);
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
});
