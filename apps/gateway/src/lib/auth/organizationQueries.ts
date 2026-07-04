import { queryOptions } from "@tanstack/react-query";
import { fetchOrganizations } from "./auth";

export const organizationKeys = {
  all: ["organizations"] as const,
};

export const organizationsQueryOptions = queryOptions({
  queryKey: organizationKeys.all,
  queryFn: () => fetchOrganizations(),
  staleTime: 5 * 60_000,
  retry: false,
});
