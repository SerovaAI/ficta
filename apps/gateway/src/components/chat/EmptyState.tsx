import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { millisecondsUntilGreetingChange, timeBasedGreeting } from "@/lib/greeting";
import { emptyStateProtectionCopy } from "@/lib/protection-copy";
import type { ProtectionStatus } from "@/lib/protection-status";

export function EmptyState({
  suggestions,
  onPick,
  protectionStatus,
  greetingName,
}: {
  suggestions: string[];
  onPick: (prompt: string) => void;
  protectionStatus?: ProtectionStatus;
  greetingName?: string;
}) {
  // The server cannot know the viewer's timezone. Start with neutral SSR copy, then calculate locally
  // after hydration and update only when the next greeting period begins.
  const [greeting, setGreeting] = useState("Let’s get to work.");
  useEffect(() => {
    let timeout: number | undefined;
    const updateGreeting = () => {
      const now = new Date();
      setGreeting(timeBasedGreeting(now.getHours(), greetingName));
      timeout = window.setTimeout(updateGreeting, millisecondsUntilGreetingChange(now));
    };
    updateGreeting();
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [greetingName]);

  return (
    // No horizontal padding here: the parent (MessageList) already applies `px-4`, and the composer +
    // protection notice share that same `max-w-3xl` measure. The suggestion grid below fills it so its
    // card edges line up with the composer instead of sitting inset.
    <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-secondary">
        <ShieldCheck className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden />
      </div>
      <h1 className="max-w-2xl text-balance break-words text-2xl font-semibold tracking-tight">{greeting}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Paste a document or ask a question. {emptyStateProtectionCopy(protectionStatus)}
      </p>
      {suggestions.length ? (
        <div className="mt-8 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-xl border border-border bg-card p-3 text-left text-sm text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
