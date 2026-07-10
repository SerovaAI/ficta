import type { DetectTextContext, ProtectedValue } from "../types.js";

/**
 * The detection-backend seam. A recognizer finds PII spans in a chunk of text and returns them as
 * {@link ProtectedValue}s (`kind: "pii"`); it does not tokenize or restore — the engine/vault own
 * that. This is the swap point behind the PII detector plugin (`pii/index.ts`): an in-process regex
 * recognizer, an out-of-process Presidio/NER sidecar, or a cloud PII service (AWS Comprehend, Azure)
 * are interchangeable implementations of this one interface.
 *
 * Contract:
 * - `detect` MUST be side-effect free and MUST NOT log values or return anything but the matched
 *   values. Signal a backend failure by throwing — the PII plugin owns failure policy and logging
 *   (fail-open: a throwing recognizer is dropped for that request; the others still run).
 * - It MAY be async (a sidecar call); the engine awaits it on the request path.
 * - Best-effort by nature: recognizers miss things. Detection is a reduction, never a guarantee.
 */
export interface PiiRecognizer {
  /** Stable, safe label for diagnostics (e.g. "regex", "presidio"). Never contains a value. */
  readonly name: string;
  /**
   * True for NLP/NER model backends (Presidio, OpenMed) that benefit from Markdown-normalized input:
   * the PII plugin masks Markdown formatting before calling these so a party name inside a `**heading**`
   * is not missed or mis-bounded. Format-anchored regex recognizers must see the RAW text (their
   * email/SSN/card boundary anchors depend on exact punctuation), so they leave this false/undefined.
   * See `pii/index.ts` detectText and `pii/markdown.ts`.
   */
  readonly usesNlp?: boolean;
  /** Find PII in `text`; return one ProtectedValue per distinct span found (empty if none). */
  detect(text: string, ctx: DetectTextContext): ProtectedValue[] | Promise<ProtectedValue[]>;
}
