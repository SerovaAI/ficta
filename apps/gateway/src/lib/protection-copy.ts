import type { ProtectionStatus } from "@/lib/protection-status";

export type ProtectionTone = "good" | "warning" | "danger" | "neutral";

export type ProtectionPresentation = {
  tone: ProtectionTone;
  label: string;
  description: string;
};

export function protectionPresentation(status: ProtectionStatus | undefined, count?: number): ProtectionPresentation {
  if (!status) {
    return {
      tone: "neutral",
      label: "Checking…",
      description: "Checking which protection layers are available for this chat.",
    };
  }

  if (!status.ok) {
    if (status.status === "unreachable") {
      return {
        tone: "warning",
        label: "Not connected",
        description:
          "Messages can't be sent or verified as protected until ficta reconnects. Start the proxy, or contact your admin if this continues.",
      };
    }
    return {
      tone: "danger",
      label: "Protection error",
      description: "Protection can't be confirmed. Restart the ficta proxy and try again.",
    };
  }

  if (status.pii.status === "blocking") {
    return {
      tone: "danger",
      label: "Sending paused",
      description: `Personal-information detection is unavailable, so messages are held until it recovers. ${stillProtectedSentence(status)}`,
    };
  }

  if (status.pii.status === "degraded") {
    return {
      tone: "warning",
      label: "Reduced protection",
      description: `Personal-information detection is temporarily unavailable. ${stillProtectedSentence(status)}`,
    };
  }

  if (!status.protection.protecting) {
    return {
      tone: "warning",
      label: "No active protection",
      description:
        "No secrets are registered and no detection layer is active, so messages would reach the AI provider unchanged.",
    };
  }

  return {
    tone: "good",
    label: typeof count === "number" ? `${count} protected` : "Protected",
    description: activeProtectionSentence(status),
  };
}

export function emptyStateProtectionCopy(status: ProtectionStatus | undefined): string {
  if (!status) return "Start drafting while ficta checks which protection layers are available.";

  if (!status.ok) {
    return status.status === "unreachable"
      ? "You can draft here, but sending stays paused until ficta reconnects and protection can be verified."
      : "You can draft here, but sending stays paused until protection can be confirmed.";
  }

  if (status.pii.status === "blocking") {
    return `Sending is paused while personal-information detection recovers. ${stillProtectedSentence(status)}`;
  }

  if (status.pii.status === "degraded") {
    return `Personal-information detection is temporarily unavailable. ${stillProtectedSentence(status)} Avoid adding new personal details until it recovers.`;
  }

  if (!status.protection.protecting) {
    return "No protection layer is active yet, so messages would reach the AI provider unchanged.";
  }

  return activeProtectionSentence(status);
}

function activeProtectionSentence(status: Extract<ProtectionStatus, { ok: true }>): string {
  const layers = activeLayers(status);
  const subject = sentenceList(layers.length > 0 ? layers : ["Sensitive values"]);
  return `ficta replaces ${subject} before the message reaches the AI provider, then restores protected values in the answer.`;
}

function stillProtectedSentence(status: Extract<ProtectionStatus, { ok: true }>): string {
  const layers: string[] = [];
  if (status.protection.registeredValues > 0) layers.push("registered secrets");
  if (status.secretShapes.enabled) layers.push("known secret shapes");
  if (layers.length === 0) return "No other protection layer is active right now.";
  return `${capitalize(sentenceList(layers))} remain protected.`;
}

function activeLayers(status: Extract<ProtectionStatus, { ok: true }>): string[] {
  const layers: string[] = [];
  if (status.protection.registeredValues > 0) layers.push("registered secrets");
  if (status.secretShapes.enabled) layers.push("known secret shapes");
  if (status.pii.status === "ok") layers.push("detected personal information");
  return layers;
}

function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "sensitive values";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
