import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { requireAuthState, scopeFromAuth } from "@/lib/auth/guards.server";
import {
  createLinearIssue,
  type IssueReportRateLimitState,
  issueReportConfig,
  issueReportDescription,
  issueReportTitle,
  takeIssueReportQuota,
} from "./issue-reporting.server";

export const ISSUE_REPORT_DETAILS_MAX = 5_000;
export type ReportKind = "bug" | "feedback";

export interface IssueReportingAvailability {
  enabled: boolean;
}

export interface IssueReportInput {
  kind: ReportKind;
  details: string;
  pagePath?: string;
  threadId?: string;
  messageId?: string;
}

export type IssueReportResult =
  | { ok: true; identifier: string; reporterEmail: string }
  | { ok: false; reason: "unavailable" | "rate_limited" | "upstream"; message: string };

const reportQuota: IssueReportRateLimitState = new Map();

/** Validate and reduce browser input to the report fields accepted by the server boundary. */
export function validateIssueReportInput(value: unknown): IssueReportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report payload.");
  const input = value as Record<string, unknown>;
  if (input.kind !== "bug" && input.kind !== "feedback") throw new Error("Choose Bug or Feedback.");
  if (typeof input.details !== "string") throw new Error("Report details are required.");
  const details = input.details.trim();
  if (!details) throw new Error("Report details are required.");
  if (details.length > ISSUE_REPORT_DETAILS_MAX) {
    throw new Error(`Report details must be ${ISSUE_REPORT_DETAILS_MAX.toLocaleString()} characters or fewer.`);
  }
  return {
    kind: input.kind,
    details,
    pagePath: optionalPagePath(input.pagePath),
    threadId: optionalThreadId(input.threadId),
    messageId: optionalMessageId(input.messageId),
  };
}

export const fetchIssueReportingAvailability = createServerFn({ method: "GET" }).handler(
  async (): Promise<IssueReportingAvailability> => ({ enabled: issueReportConfig() !== null }),
);

export const submitIssueReport = createServerFn({ method: "POST" })
  .validator(validateIssueReportInput)
  .handler(async ({ data }): Promise<IssueReportResult> => {
    const config = issueReportConfig();
    if (!config) {
      return {
        ok: false,
        reason: "unavailable",
        message: "Issue reporting is unavailable right now. Contact your administrator.",
      };
    }

    const auth = await requireAuthState();
    const scope = scopeFromAuth(auth);
    if (!scope || !auth.user) throw new Error("unauthorized");

    const scopeKey = JSON.stringify([scope.userId, scope.orgId]);
    if (!takeIssueReportQuota(reportQuota, scopeKey)) {
      return {
        ok: false,
        reason: "rate_limited",
        message: "You've sent several reports recently. Try again in a few minutes.",
      };
    }

    const correlationId = crypto.randomUUID();
    const result = await createLinearIssue(
      {
        title: issueReportTitle(data.kind, data.details),
        description: issueReportDescription({
          ...data,
          reporterName: auth.user.name,
          reporterEmail: auth.user.email,
          userId: scope.userId,
          organizationId: scope.orgId,
          submittedAt: new Date().toISOString(),
          buildId: config.buildId,
          userAgent: getRequestHeader("user-agent"),
        }),
        teamId: config.teamId,
      },
      config,
    );

    if (result.ok) return { ok: true, identifier: result.identifier, reporterEmail: auth.user.email };

    console.warn("Issue report submission failed.", {
      correlationId,
      category: result.category,
      ...(result.status ? { status: result.status } : {}),
    });
    if (result.category === "rate_limited") {
      return {
        ok: false,
        reason: "rate_limited",
        message: "Issue reporting is busy right now. Try again in a few minutes.",
      };
    }
    return {
      ok: false,
      reason: "upstream",
      message: "We couldn't send this report. Your details are still here — try again.",
    };
  });

function optionalPagePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 500 ||
    value.includes("?") ||
    value.includes("#") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error("Invalid report page path.");
  }
  return value;
}

function optionalThreadId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid report chat id.");
  }
  return value;
}

function optionalMessageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid report response id.");
  }
  return value;
}
