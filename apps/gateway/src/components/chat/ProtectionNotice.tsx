import { AlertTriangle } from "lucide-react";
import { type ProtectionStatus, requiredRegistryBlock } from "@/lib/protection-status";
import { cn } from "@/lib/utils";

export function ProtectionNotice({ status }: { status?: ProtectionStatus }) {
  const notice = noticeFor(status);
  if (!notice) return null;

  return (
    // Share the composer's exact measure: max-w-3xl column, box inset by px-4, so the notice border
    // lines up edge-to-edge with the composer box below it.
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div
        role="alert"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-sm",
          notice.tone === "danger"
            ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100"
            : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100",
        )}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{notice.title}</p>
          <p className="mt-1 text-current/90">{notice.body}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Turns raw proxy posture into plain, outcome-first copy for people who don't run the redaction stack.
 * Two rules: (1) say what it means for the user's message, not which sidecar failed — infra names
 * ("Presidio", "fail-open") stay out of the banner; (2) only the red tone means a real failure. A proxy
 * that simply isn't running yet is amber "not connected", not a blood-red error.
 */
function noticeFor(status: ProtectionStatus | undefined):
  | {
      tone: "warning" | "danger";
      title: string;
      body: string;
    }
  | undefined {
  if (!status) return undefined;

  if (!status.ok) {
    // Not running yet (dev server not started, proxy down) reads as setup, not breakage.
    if (status.status === "unreachable") {
      return {
        tone: "warning",
        title: "ficta isn't connected",
        body: "Messages can't be sent or verified as protected until the ficta proxy is running. Start the proxy, or contact your admin if this keeps happening.",
      };
    }
    return {
      tone: "danger",
      title: "Protection can't be confirmed",
      body: "ficta responded unexpectedly, so your messages can't be verified as protected. Restart the proxy and try again.",
    };
  }

  const registryBlock = requiredRegistryBlock(status);
  if (registryBlock) {
    return {
      tone: "danger",
      title: "Chat is paused until the protected registry is ready",
      body: `${registryBlock.message} Contact your admin if this continues.`,
    };
  }

  if (status.pii.status === "blocking") {
    return {
      tone: "danger",
      title: "Chat is paused to keep you safe",
      body: `Automatic detection of personal information is temporarily unavailable, so ficta is holding messages until it recovers rather than risk sending something unprotected. ${stillProtectedSentence(status)} Contact your admin if this continues.`,
    };
  }

  if (status.pii.status === "degraded") {
    return {
      tone: "warning",
      title: "Protection is reduced",
      body: `Automatic detection of personal information is temporarily unavailable. ${stillProtectedSentence(status)} Avoid pasting new personal details until protection recovers.`,
    };
  }

  if (!status.protection.protecting) {
    return {
      tone: "warning",
      title: "No active protection",
      body: "No secrets are registered yet, so messages are sent to the AI provider unchanged. Register the values you want protected to turn redaction on.",
    };
  }

  return undefined;
}

/** What's *still* covered when PII detection drops, in plain terms. Never overstates: if nothing else is
 * active, it says so. */
function stillProtectedSentence(status: Extract<ProtectionStatus, { ok: true }>): string {
  const layers: string[] = [];
  if (status.protection.registeredValues > 0) layers.push("your registered secrets");
  if (status.secretShapes.enabled) layers.push("known secret shapes");
  if (layers.length === 0) return "No other protection is active right now.";
  return `${sentenceList(layers)} are still protected.`;
}

function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return capitalize(parts[0] ?? "Sensitive values");
  if (parts.length === 2) return capitalize(`${parts[0]} and ${parts[1]}`);
  return capitalize(`${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
