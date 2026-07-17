import { useRouteContext } from "@tanstack/react-router";
import type { IssueReportingAvailability } from "./issue-reporting";

const FALLBACK: IssueReportingAvailability = { enabled: false };

/** Read the secret-free reporting availability resolved by the root route. */
export function useIssueReportingAvailability(): IssueReportingAvailability {
  return useRouteContext({
    from: "__root__",
    select: (context) => (context as { issueReporting?: IssueReportingAvailability }).issueReporting ?? FALLBACK,
  });
}
