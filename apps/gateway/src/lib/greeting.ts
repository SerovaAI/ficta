import type { AuthState } from "./auth/types";

export type TimeOfDay = "morning" | "afternoon" | "evening";

/** Map a browser-local hour to the three greeting periods used by the empty chat state. */
export function timeOfDay(hour: number): TimeOfDay {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** Use a hosted profile's first name, while keeping local and unnamed sessions impersonal. */
export function greetingName(auth: Pick<AuthState, "requiresAuth" | "user">): string | undefined {
  if (!auth.requiresAuth) return undefined;
  const name = auth.user?.name?.trim();
  return name ? name.split(/\s+/)[0] : undefined;
}

export function timeBasedGreeting(hour: number, name?: string): string {
  const salutation = `Good ${timeOfDay(hour)}`;
  return name ? `${salutation}, ${name} — let’s get to work.` : `${salutation} — let’s get to work.`;
}

/** Milliseconds until the next local noon, 18:00, or midnight greeting transition. */
export function millisecondsUntilGreetingChange(now: Date): number {
  const next = new Date(now);
  if (now.getHours() < 12) {
    next.setHours(12, 0, 0, 0);
  } else if (now.getHours() < 18) {
    next.setHours(18, 0, 0, 0);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
  }
  return Math.max(1, next.getTime() - now.getTime());
}
