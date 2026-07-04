import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProtectionStatus } from "@/lib/protection-status";
import { cn } from "@/lib/utils";

/**
 * Surfaces ficta's current protection posture in plain, outcome-first language. The label says what it
 * means for the user's next message; infra names ("Presidio", "fail-open/closed") stay out of it. The
 * full explanation is in the tooltip and, for screen readers, in the always-present `aria-describedby`
 * text — so the badge reads completely without hovering. `count`, when the proxy provides it, becomes a
 * per-session "N protected" tally; until then the happy state reads simply "Protected".
 */
export function ProtectionBadge({
  count,
  status,
  className,
  labelClassName,
}: {
  count?: number;
  status?: ProtectionStatus;
  className?: string;
  /** Lets callers collapse the badge to icon-only on small screens (e.g. `hidden sm:inline`) while the
   * tooltip + `aria-describedby` text keep the full state available. */
  labelClassName?: string;
}) {
  const descriptionId = useId();
  const view = badgeView(status, count);
  const Icon = view.tone === "good" ? ShieldCheck : AlertTriangle;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-describedby={descriptionId}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
            toneClass(view.tone),
            className,
          )}
        >
          <Icon className={cn("size-3.5 shrink-0", iconClass(view.tone))} aria-hidden />
          <span className={cn("truncate", labelClassName)}>{view.label}</span>
        </button>
      </TooltipTrigger>
      <span id={descriptionId} className="sr-only">
        {view.description}
      </span>
      <TooltipContent className="max-w-72 text-center">{view.description}</TooltipContent>
    </Tooltip>
  );
}

function badgeView(status: ProtectionStatus | undefined, count: number | undefined) {
  if (!status) {
    return {
      tone: "neutral" as const,
      label: "Checking…",
      description: "Checking whether ficta is protecting this chat…",
    };
  }

  if (!status.ok) {
    // Proxy not running yet is a setup state, not a failure — keep it calm (amber), not red.
    if (status.status === "unreachable") {
      return {
        tone: "warning" as const,
        label: "Not connected",
        description:
          "ficta isn't running, so messages can't be sent or verified as protected. Start the proxy, or contact your admin if this keeps happening.",
      };
    }
    return {
      tone: "danger" as const,
      label: "Protection error",
      description: "ficta responded unexpectedly, so protection can't be confirmed. Restart the proxy and try again.",
    };
  }

  if (status.pii.status === "blocking") {
    return {
      tone: "danger" as const,
      label: "Chat paused",
      description: `Automatic detection of personal information is temporarily unavailable, so ficta is holding messages until it recovers. ${stillProtectedSentence(status)}`,
    };
  }

  if (status.pii.status === "degraded") {
    return {
      tone: "warning" as const,
      label: "Reduced protection",
      description: `Automatic detection of personal information is temporarily unavailable. ${stillProtectedSentence(status)}`,
    };
  }

  if (!status.protection.protecting) {
    return {
      tone: "warning" as const,
      label: "No protection yet",
      description: "No secrets are registered yet, so messages are sent to the AI provider unchanged.",
    };
  }

  return {
    tone: "good" as const,
    label: typeof count === "number" ? `${count} protected` : "Protected",
    description: protectionDescription(status),
  };
}

function protectionDescription(status: Extract<ProtectionStatus, { ok: true }>): string {
  const parts: string[] = [];
  if (status.protection.registeredValues > 0) parts.push("your registered secrets");
  if (status.secretShapes.enabled) parts.push("known secret shapes");
  if (status.pii.status === "ok") parts.push("detected personal information");
  if (parts.length === 0) {
    return "Sensitive values are replaced with tokens before your message reaches the AI provider, then restored in the reply.";
  }
  return `${sentenceList(parts)} are replaced with tokens before your message reaches the AI provider, then restored in the reply.`;
}

/** Plain statement of what's still covered when PII detection drops — never overstates. */
function stillProtectedSentence(status: Extract<ProtectionStatus, { ok: true }>): string {
  const layers: string[] = [];
  if (status.protection.registeredValues > 0) layers.push("your registered secrets");
  if (status.secretShapes.enabled) layers.push("known secret shapes");
  if (layers.length === 0) return "No other protection is active right now.";
  return `${capitalize(sentenceList(layers))} are still protected.`;
}

function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "Sensitive values";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toneClass(tone: "good" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "good":
      return "border-border bg-secondary text-secondary-foreground";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100";
    case "danger":
      return "border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100";
    case "neutral":
      return "border-border bg-secondary text-muted-foreground";
  }
}

function iconClass(tone: "good" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "good":
      return "text-emerald-600 dark:text-emerald-400";
    case "warning":
      return "text-amber-700 dark:text-amber-300";
    case "danger":
      return "text-red-700 dark:text-red-300";
    case "neutral":
      return "text-muted-foreground";
  }
}
