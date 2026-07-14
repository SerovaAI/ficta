import type { UIMessage } from "@tanstack/ai-react";
import { stripRestoreHighlightMarkers } from "@/lib/restore-highlights";

/**
 * Restoration telemetry (gateway-only).
 *
 * The gateway receives the response *after* the proxy has restored surrogates → real values, so any
 * `FICTA_…` token still visible to the user is a restoration failure: the model truncated the surrogate
 * (`FICTA_62a02923…`), invented one, or referenced a surrogate the proxy couldn't map (e.g. across a
 * restart). Scanning the finished assistant message for these lets us measure how often it happens —
 * the number that decides whether the preserve-literals prompt is enough or we need retry / a shorter
 * token format. This is measurement only; it never changes the response.
 */

// A complete minted surrogate: opaque, typed literal, or context-bound entity-family token.
const COMPLETE_SURROGATE =
  /^FICTA_(?:[0-9a-f]{32}|[A-Z0-9]{1,12}_[0-9a-f]{32}|(?:ORG|PERSON)_[A-Z2-7]{12}_[A-Z2-7]{12})$/;
// Any surrogate-shaped run, so a shortened token (`FICTA_62a02923`) is caught as well as a complete one.
const SURROGATE_LIKE = /FICTA_[0-9A-Za-z_]+/g;

export interface RestoreValidation {
  /** Full surrogate tokens that reached the user un-restored (invented, or minted in an unmapped scope). */
  complete: string[];
  /** Shortened / partial surrogate tokens — the model truncated them, so the proxy could not restore. */
  truncated: string[];
  /** complete.length + truncated.length; 0 means a clean, fully-restored response. */
  total: number;
}

/** Classify every residual surrogate-shaped token in already-restored (marker-free) text. */
export function validateRestoredText(text: string): RestoreValidation {
  const complete: string[] = [];
  const truncated: string[] = [];
  for (const match of text.matchAll(SURROGATE_LIKE)) {
    const token = match[0];
    if (token.startsWith("FICTA_RESTORE_")) continue; // restore-highlight marker sentinel, not a surrogate
    if (COMPLETE_SURROGATE.test(token)) complete.push(token);
    else truncated.push(token);
  }
  return { complete, truncated, total: complete.length + truncated.length };
}

/** Validate a finished assistant message: strip highlight markers first so only user-visible text is scanned. */
export function validateRestoredMessage(message: UIMessage): RestoreValidation {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => stripRestoreHighlightMarkers(part.content))
    .join("\n");
  return validateRestoredText(text);
}

/** Validate a finished message and, when restoration was incomplete, warn with counts + a few samples. */
export function reportRestoreValidation(message: UIMessage): RestoreValidation {
  const result = validateRestoredMessage(message);
  if (result.total > 0) {
    console.warn(
      `[ficta] restoration incomplete: ${result.total} surrogate token(s) reached the user ` +
        `(${result.truncated.length} truncated, ${result.complete.length} unmatched).`,
      { truncated: result.truncated.slice(0, 5), unmatched: result.complete.slice(0, 5) },
    );
  }
  return result;
}
