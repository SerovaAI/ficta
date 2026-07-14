import { describe, expect, it } from "vitest";
import { LOCAL_AUTH_STATE } from "@/lib/auth/types";
import { greetingName, millisecondsUntilGreetingChange, timeBasedGreeting, timeOfDay } from "@/lib/greeting";

describe("time-based greeting", () => {
  it.each([
    [0, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [23, "evening"],
  ] as const)("maps hour %i to %s", (hour, expected) => {
    expect(timeOfDay(hour)).toBe(expected);
  });

  it("formats the hosted and unnamed copy exactly", () => {
    expect(timeBasedGreeting(9, "Stefan")).toBe("Good morning, Stefan — let’s get to work.");
    expect(timeBasedGreeting(14)).toBe("Good afternoon — let’s get to work.");
    expect(timeBasedGreeting(20, "Stefan")).toBe("Good evening, Stefan — let’s get to work.");
  });

  it("schedules the next local greeting boundary", () => {
    expect(millisecondsUntilGreetingChange(new Date(2026, 6, 14, 11, 59, 59, 500))).toBe(500);
    expect(millisecondsUntilGreetingChange(new Date(2026, 6, 14, 17, 59, 59, 0))).toBe(1_000);
    expect(millisecondsUntilGreetingChange(new Date(2026, 6, 14, 23, 59, 59, 999))).toBe(1);
  });
});

describe("greeting name", () => {
  it("uses the first whitespace-delimited hosted profile name", () => {
    expect(
      greetingName({
        requiresAuth: true,
        user: { id: "user_1", email: "ada@example.com", name: "  Ada   Lovelace  " },
      }),
    ).toBe("Ada");
  });

  it("preserves a hosted mononym", () => {
    expect(
      greetingName({
        requiresAuth: true,
        user: { id: "user_1", email: "prince@example.com", name: "Prince" },
      }),
    ).toBe("Prince");
  });

  it("omits the self-hosted local identity", () => {
    expect(greetingName(LOCAL_AUTH_STATE)).toBeUndefined();
  });

  it("omits missing or whitespace-only hosted names", () => {
    expect(greetingName({ requiresAuth: true, user: null })).toBeUndefined();
    expect(
      greetingName({
        requiresAuth: true,
        user: { id: "user_1", email: "unnamed@example.com", name: "   " },
      }),
    ).toBeUndefined();
  });
});
