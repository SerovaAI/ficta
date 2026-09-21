import { useRouteContext } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { SecondOpinionAvailability } from "./second-opinion";
import { secondOpinionAvailability } from "./second-opinion.server";

const FALLBACK: SecondOpinionAvailability = { available: false };

/** Public, secret-free: whether the deployment can offer a second opinion and whether env pins it. */
export const fetchSecondOpinionAvailability = createServerFn({ method: "GET" }).handler(
  async (): Promise<SecondOpinionAvailability> => secondOpinionAvailability(),
);

/** Read the availability the root route placed in router context. */
export function useSecondOpinionAvailability(): SecondOpinionAvailability {
  return useRouteContext({
    from: "__root__",
    select: (context) => (context as { secondOpinion?: SecondOpinionAvailability }).secondOpinion ?? FALLBACK,
  });
}
