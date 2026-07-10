import { createHmac, randomBytes } from "node:crypto";
import type { ProtectedValue } from "./plugins/types.js";

/**
 * How a value becomes a surrogate token, and how tokens are recognized on the way back — the seam
 * that lets the token *format* be swapped (opaque `FICTA_<hex>` by default; per-kind *typed*
 * surrogates like `FICTA_PERSON_<hex>` via {@link typedSurrogateStrategy}) without touching the
 * vault's replace/restore/streaming mechanics.
 *
 * A strategy MUST be deterministic (same value → same token within a run) and its tokens MUST be
 * JSON-safe and matchable by `pattern`, or streaming restore will break.
 */

/** Advisory context for minting a typed surrogate. The opaque strategy ignores it. */
export interface SurrogateHint {
  /** The detector's category label (`ProtectedValue.name`), e.g. "person", "us-ssn". */
  name?: string;
  /** Coarse kind, used as the fallback type segment when the category is unmapped. */
  kind?: ProtectedValue["kind"];
}

export interface SurrogateStrategy {
  /** Deterministically mint the surrogate token for a value. `hint` steers typed surrogates; the
   *  opaque strategy ignores it. */
  mint(value: string, hint?: SurrogateHint): string;
  /** Global regex matching one complete surrogate token; used to scan text/JSON on restore. */
  readonly pattern: RegExp;
  /** Upper bound on a token's length; used for streaming hold-back at chunk/fragment edges. */
  readonly maxLength: number;
  /** Whether `text` could be the leading fragment of a not-yet-complete surrogate token. */
  isPotentialPrefix(text: string): boolean;
}

const HEX_PREFIX = "FICTA_";
const HEX_LEN = 32;
const HEX_TOTAL = HEX_PREFIX.length + HEX_LEN;

const ENV_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY;
// One key per process by default (same value → same surrogate across turns). Set
// FICTA_SURROGATE_KEY for cross-restart stability.
const DEFAULT_KEY = ENV_SURROGATE_KEY ?? randomBytes(32).toString("hex");

/** The built-in strategy: `FICTA_` + 32 hex chars of HMAC-SHA256(value) — opaque and JSON-safe. */
export function hexSurrogateStrategy(key: string = DEFAULT_KEY): SurrogateStrategy {
  return {
    mint(value) {
      return HEX_PREFIX + createHmac("sha256", key).update(value).digest("hex").slice(0, HEX_LEN);
    },
    pattern: new RegExp(`${HEX_PREFIX}[0-9a-f]{${HEX_LEN}}`, "g"),
    maxLength: HEX_TOTAL,
    isPotentialPrefix(text) {
      if (!text || text.length >= HEX_TOTAL) return false;
      if (HEX_PREFIX.startsWith(text)) return true;
      if (!text.startsWith(HEX_PREFIX)) return false;
      return /^[0-9a-f]*$/.test(text.slice(HEX_PREFIX.length));
    },
  };
}

const MAX_TYPE_LEN = 12; // bounds the `<TYPE>` segment so the token stays a fixed, safe shape
const TYPED_TOTAL = HEX_PREFIX.length + MAX_TYPE_LEN + 1 + HEX_LEN; // FICTA_ + TYPE + _ + hex

/**
 * Typed surrogates: `FICTA_<TYPE>_<hex>` (e.g. `FICTA_PERSON_ab12…`, `FICTA_SSN_…`). The 32-hex tail
 * is the same keyed HMAC as the opaque strategy — reversibility and determinism are unchanged — but a
 * short, model-legible `<TYPE>` is prepended so the model keeps a grammatical/semantic cue for the
 * redacted span ("the FICTA_PERSON_ab12 patient" reads far better than "the FICTA_ab12 patient").
 *
 * Why a TYPE segment and not a realistic fake value (a fake-but-valid SSN, à la Presidio's Faker/AHDS
 * surrogates): a real-looking surrogate is indistinguishable from genuine PII on the restore/leak
 * scan and can collide with a real value. Keeping the unambiguous `FICTA_` prefix and a bounded
 * `[A-Z0-9]` type keeps the leak gate and restore exact while still recovering most of the fluency.
 *
 * The `<TYPE>` is drawn ONLY from {@link CATEGORY_TYPE} or a coarse kind fallback, so an arbitrary
 * label (e.g. a registered secret's env-var name) never leaks into the token.
 */
export function typedSurrogateStrategy(key: string = DEFAULT_KEY): SurrogateStrategy {
  const continuation = new RegExp(`^[A-Z0-9]{0,${MAX_TYPE_LEN}}(?:_[0-9a-f]{0,${HEX_LEN}})?$`);
  return {
    mint(value, hint) {
      const type = surrogateType(hint);
      const hex = createHmac("sha256", key).update(value).digest("hex").slice(0, HEX_LEN);
      return `${HEX_PREFIX}${type}_${hex}`;
    },
    pattern: new RegExp(`${HEX_PREFIX}[A-Z0-9]{1,${MAX_TYPE_LEN}}_[0-9a-f]{${HEX_LEN}}`, "g"),
    maxLength: TYPED_TOTAL,
    isPotentialPrefix(text) {
      if (!text || text.length >= TYPED_TOTAL) return false;
      if (HEX_PREFIX.startsWith(text)) return true;
      if (!text.startsWith(HEX_PREFIX)) return false;
      return continuation.test(text.slice(HEX_PREFIX.length));
    },
  };
}

/**
 * Select the surrogate token style from the environment: `typed` → {@link typedSurrogateStrategy};
 * anything else (default) → the opaque {@link hexSurrogateStrategy}. Kept opaque by default so the
 * token shape only changes when explicitly opted in.
 */
export function surrogateStrategy(env: NodeJS.ProcessEnv = process.env, key: string = DEFAULT_KEY): SurrogateStrategy {
  return surrogateStyle(env) === "typed" ? typedSurrogateStrategy(key) : hexSurrogateStrategy(key);
}

/**
 * The active surrogate token style from the environment. Single source of truth shared by the
 * strategy factory above, the startup banner, and `ficta doctor`, so all three always agree.
 */
export function surrogateStyle(env: NodeJS.ProcessEnv = process.env): "opaque" | "typed" {
  return env.FICTA_SURROGATE_STYLE?.trim().toLowerCase() === "typed" ? "typed" : "opaque";
}

/** The `<TYPE>` for a value's surrogate: mapped category → coarse kind fallback → generic tag. */
function surrogateType(hint?: SurrogateHint): string {
  const mapped = hint?.name ? CATEGORY_TYPE[hint.name.toLowerCase()] : undefined;
  if (mapped) return mapped;
  switch (hint?.kind) {
    case "secret":
      return "SECRET";
    case "pii":
      return "PII";
    default:
      return "REDACTED";
  }
}

/**
 * Detector category (`ProtectedValue.name`, lowercase-hyphenated) → short surrogate type. Adapted and
 * condensed from Presidio's anonymizer entity taxonomy, keyed on the names ficta's detectors actually
 * emit (regex-recognizer, presidio-recognizer `categoryOf`, secret-shapes). Unmapped names fall back
 * to the coarse kind, so this table only needs the common, fluency-relevant entities.
 */
const CATEGORY_TYPE: Record<string, string> = {
  // People & prose PII (where the fluency win matters most)
  person: "PERSON",
  nrp: "PERSON",
  email: "EMAIL",
  "email-address": "EMAIL",
  phone: "PHONE",
  "phone-number": "PHONE",
  "fax-number": "PHONE",
  location: "LOCATION",
  address: "ADDRESS",
  "street-address": "ADDRESS",
  "date-time": "DATE",
  date: "DATE",
  age: "AGE",
  organization: "ORG",
  url: "URL",
  "ip-address": "IP",
  // Identifiers & financial
  ssn: "SSN",
  "us-ssn": "SSN",
  "credit-card": "CARD",
  crypto: "CRYPTO",
  "iban-code": "ACCOUNT",
  "us-bank-number": "ACCOUNT",
  "us-itin": "ID",
  "us-driver-license": "ID",
  "us-passport": "ID",
  id: "ID",
  "document-id": "ID",
  "medical-license": "ID",
  "uk-nhs": "ID",
  "uk-nino": "ID",
  // Secrets (specific shapes; the rest fall back to SECRET via kind)
  "private-key": "KEY",
  jwt: "JWT",
};
