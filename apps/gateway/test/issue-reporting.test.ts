import { describe, expect, it, vi } from "vitest";
import { ISSUE_REPORT_DETAILS_MAX, validateIssueReportInput } from "@/lib/issue-reporting";
import {
  createLinearIssue,
  issueReportConfig,
  issueReportDescription,
  issueReportTitle,
  takeIssueReportQuota,
} from "@/lib/issue-reporting.server";

describe("issue reporting configuration", () => {
  it("enables reporting only when both server-side Linear values are present", () => {
    expect(issueReportConfig({})).toBeNull();
    expect(issueReportConfig({ FICTA_GATEWAY_LINEAR_API_KEY: "secret" })).toBeNull();
    expect(
      issueReportConfig({
        FICTA_GATEWAY_LINEAR_API_KEY: " secret ",
        FICTA_GATEWAY_LINEAR_TEAM_ID: " team-id ",
        FICTA_GATEWAY_BUILD_ID: " build-42 ",
      }),
    ).toEqual({ apiKey: "secret", teamId: "team-id", buildId: "build-42" });
  });
});

describe("issue report input", () => {
  it("trims valid input and keeps only the accepted diagnostic fields", () => {
    expect(
      validateIssueReportInput({
        kind: "bug",
        details: "  Composer lost my draft.  ",
        pagePath: "/chat/thread-1",
        threadId: "thread-1",
        transcript: "must not cross the boundary",
      }),
    ).toEqual({
      kind: "bug",
      details: "Composer lost my draft.",
      pagePath: "/chat/thread-1",
      threadId: "thread-1",
    });
  });

  it("rejects invalid kinds, empty or oversized details, paths, and chat ids", () => {
    expect(() => validateIssueReportInput({ kind: "question", details: "hello" })).toThrow("Choose Bug");
    expect(() => validateIssueReportInput({ kind: "bug", details: "   " })).toThrow("required");
    expect(() => validateIssueReportInput({ kind: "bug", details: "x".repeat(ISSUE_REPORT_DETAILS_MAX + 1) })).toThrow(
      "characters or fewer",
    );
    expect(() => validateIssueReportInput({ kind: "bug", details: "hello", pagePath: "/chat?a=secret" })).toThrow(
      "page path",
    );
    expect(() => validateIssueReportInput({ kind: "bug", details: "hello", pagePath: `/${"x".repeat(500)}` })).toThrow(
      "page path",
    );
    expect(() => validateIssueReportInput({ kind: "bug", details: "hello", threadId: "invalid/id" })).toThrow(
      "chat id",
    );
    expect(() => validateIssueReportInput({ kind: "bug", details: "hello", threadId: "x".repeat(129) })).toThrow(
      "chat id",
    );
  });
});

describe("issue report content", () => {
  it("builds a normalized, capped title from the first non-empty line", () => {
    expect(issueReportTitle("bug", "\n  Composer   loses my draft  \nMore detail")).toBe(
      "[Bug] Composer loses my draft",
    );
    expect(issueReportTitle("feedback", "x".repeat(200))).toHaveLength(100);
  });

  it("includes only the approved reporter and safe diagnostic metadata", () => {
    const description = issueReportDescription({
      kind: "bug",
      details: "The composer cleared after I changed models.",
      reporterName: "Ada\nInjected heading",
      reporterEmail: "ada@example.com",
      userId: "user_123",
      organizationId: "org_123",
      submittedAt: "2026-07-16T12:00:00.000Z",
      buildId: "abc123",
      userAgent: "Example Browser",
      pagePath: "/chat/thread-123",
      threadId: "thread-123",
    });

    expect(description).toContain("## Report\n\nThe composer cleared after I changed models.");
    expect(description).toContain("- Name: Ada Injected heading");
    expect(description).toContain("- Email: ada@example.com");
    expect(description).toContain("- Workspace ID: org_123");
    expect(description).toContain("- Gateway build: abc123");
    expect(description).toContain("- Chat ID: thread-123");
    expect(description).not.toContain("transcript");
    expect(description).not.toContain("attachment");
    expect(description).not.toContain("protected value");
  });
});

describe("issue report limiter", () => {
  it("allows five reports per scope in ten minutes and expires old attempts", () => {
    const state = new Map<string, number[]>();
    for (let index = 0; index < 5; index += 1) expect(takeIssueReportQuota(state, "user/org", index)).toBe(true);
    expect(takeIssueReportQuota(state, "user/org", 5)).toBe(false);
    expect(takeIssueReportQuota(state, "other/org", 5)).toBe(true);
    expect(takeIssueReportQuota(state, "user/org", 10 * 60_000 + 1)).toBe(true);
  });
});

describe("Linear issue creation", () => {
  const config = { apiKey: "linear-secret", teamId: "team-123" };
  const input = { title: "[Bug] Lost draft", description: "Details", teamId: "team-123" };

  it("uses variables, the personal-key header, and returns the created identifier", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toEqual({
        accept: "application/json",
        authorization: "linear-secret",
        "content-type": "application/json",
      });
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("issueCreate(input: $input)");
      expect(body.query).toContain("issue { identifier }");
      expect(body.variables).toEqual({ input });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "FIC-123" } } } });
    });

    await expect(createLinearIssue(input, config, fetchImpl)).resolves.toEqual({ ok: true, identifier: "FIC-123" });
  });

  it("classifies HTTP, rate-limit, GraphQL, malformed, and network failures", async () => {
    await expect(createLinearIssue(input, config, async () => new Response(null, { status: 401 }))).resolves.toEqual({
      ok: false,
      category: "http",
      status: 401,
    });
    await expect(createLinearIssue(input, config, async () => new Response(null, { status: 500 }))).resolves.toEqual({
      ok: false,
      category: "http",
      status: 500,
    });
    await expect(createLinearIssue(input, config, async () => new Response(null, { status: 429 }))).resolves.toEqual({
      ok: false,
      category: "rate_limited",
      status: 429,
    });
    await expect(
      createLinearIssue(input, config, async () => Response.json({ errors: [{ message: "forbidden" }] })),
    ).resolves.toEqual({ ok: false, category: "graphql", status: 200 });
    await expect(createLinearIssue(input, config, async () => Response.json({ data: {} }))).resolves.toEqual({
      ok: false,
      category: "malformed",
      status: 200,
    });
    await expect(createLinearIssue(input, config, async () => new Response("not-json"))).resolves.toEqual({
      ok: false,
      category: "malformed",
      status: 200,
    });
    await expect(
      createLinearIssue(input, config, async () => {
        throw new Error("offline");
      }),
    ).resolves.toEqual({ ok: false, category: "network" });
  });

  it("aborts a stalled Linear request after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const stalledFetch = vi.fn<typeof fetch>(async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      });

      const result = createLinearIssue(input, config, stalledFetch, 250);
      await vi.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toEqual({ ok: false, category: "network" });
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
