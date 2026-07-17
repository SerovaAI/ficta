const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REPORT_WINDOW_MS = 10 * 60_000;
const REPORTS_PER_WINDOW = 5;
const RATE_LIMIT_BUCKET_MAX = 10_000;
const LINEAR_REQUEST_TIMEOUT_MS = 10_000;

export interface IssueReportConfig {
  apiKey: string;
  teamId: string;
  buildId?: string;
}

export interface IssueReportContext {
  kind: "bug" | "feedback";
  details: string;
  reporterName?: string;
  reporterEmail: string;
  userId: string;
  organizationId: string;
  submittedAt: string;
  buildId?: string;
  userAgent?: string;
  pagePath?: string;
  threadId?: string;
  messageId?: string;
}

export interface LinearIssueInput {
  title: string;
  description: string;
  teamId: string;
}

export type LinearIssueResult =
  | { ok: true; identifier: string }
  | {
      ok: false;
      category: "network" | "rate_limited" | "http" | "graphql" | "malformed";
      status?: number;
    };

export type IssueReportRateLimitState = Map<string, number[]>;

/** Read the server-only Linear configuration, enabling reports only when both required values exist. */
export function issueReportConfig(env: NodeJS.ProcessEnv = process.env): IssueReportConfig | null {
  const apiKey = env.FICTA_GATEWAY_LINEAR_API_KEY?.trim();
  const teamId = env.FICTA_GATEWAY_LINEAR_TEAM_ID?.trim();
  if (!apiKey || !teamId) return null;
  const buildId = env.FICTA_GATEWAY_BUILD_ID?.trim();
  return { apiKey, teamId, ...(buildId ? { buildId } : {}) };
}

/** Build a normalized Linear issue title from the first non-empty report line. */
export function issueReportTitle(kind: IssueReportContext["kind"], details: string): string {
  const prefix = kind === "bug" ? "[Bug] " : "[Feedback] ";
  const firstLine = details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const summary = (firstLine ?? "Issue report").replace(/\s+/g, " ");
  return `${prefix}${summary}`.slice(0, 100).trimEnd();
}

/** Format the report and allowlisted diagnostic fields for the Linear issue description. */
export function issueReportDescription(context: IssueReportContext): string {
  const reporterName = cleanMetadata(context.reporterName) || "Not provided";
  const buildId = cleanMetadata(context.buildId) || "Not provided";
  const userAgent = cleanMetadata(context.userAgent) || "Not provided";
  const pagePath = cleanMetadata(context.pagePath) || "Not provided";
  const threadId = cleanMetadata(context.threadId) || "Not provided";
  const messageId = cleanMetadata(context.messageId) || "Not provided";

  return [
    "## Report",
    "",
    context.details,
    "",
    "## Reporter",
    "",
    `- Name: ${reporterName}`,
    `- Email: ${cleanMetadata(context.reporterEmail)}`,
    `- User ID: ${cleanMetadata(context.userId)}`,
    `- Workspace ID: ${cleanMetadata(context.organizationId)}`,
    "",
    "## Diagnostics",
    "",
    `- Submitted at: ${cleanMetadata(context.submittedAt)}`,
    `- Gateway build: ${buildId}`,
    `- Browser: ${userAgent}`,
    `- Page: ${pagePath}`,
    `- Chat ID: ${threadId}`,
    `- Response ID: ${messageId}`,
  ].join("\n");
}

/**
 * Best-effort process-local protection against a signed-in user flooding the configured Linear team.
 * The map stores timestamps only — never report content or identity metadata beyond the opaque scope key.
 */
export function takeIssueReportQuota(state: IssueReportRateLimitState, scopeKey: string, now = Date.now()): boolean {
  const cutoff = now - REPORT_WINDOW_MS;
  const recent = (state.get(scopeKey) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= REPORTS_PER_WINDOW) {
    state.set(scopeKey, recent);
    return false;
  }
  recent.push(now);
  state.set(scopeKey, recent);

  // Bound memory for long-lived processes. Removing the oldest inserted key is sufficient for this
  // best-effort limiter; Linear and the auth boundary remain the durable controls.
  if (state.size > RATE_LIMIT_BUCKET_MAX) {
    const oldestKey = state.keys().next().value;
    if (typeof oldestKey === "string") state.delete(oldestKey);
  }
  return true;
}

/** Create an issue through Linear's GraphQL API with a bounded request duration. */
export async function createLinearIssue(
  input: LinearIssueInput,
  config: IssueReportConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = LINEAR_REQUEST_TIMEOUT_MS,
): Promise<LinearIssueResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation CreateGatewayIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier }
  }
}`,
        variables: { input },
      }),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, category: "network" };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return {
      ok: false,
      category: response.status === 429 ? "rate_limited" : "http",
      status: response.status,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, category: "malformed", status: response.status };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, category: "malformed", status: response.status };
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return { ok: false, category: "graphql", status: response.status };
  }
  const data = asRecord(record.data);
  const issueCreate = asRecord(data?.issueCreate);
  const issue = asRecord(issueCreate?.issue);
  if (issueCreate?.success !== true || typeof issue?.identifier !== "string" || !issue.identifier.trim()) {
    return { ok: false, category: "malformed", status: response.status };
  }
  return { ok: true, identifier: issue.identifier.trim() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Keep metadata on one line so user/provider-controlled strings cannot reshape the Markdown sections. */
function cleanMetadata(value: string | undefined): string {
  return (
    value
      ?.replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}
