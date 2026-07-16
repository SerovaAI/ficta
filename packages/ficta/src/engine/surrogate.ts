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

export interface EntitySurrogateInput {
  protectionContextId: string;
  entityId: string;
  entityType: "organization" | "person";
  exactSurface: string;
}

export interface EntitySurrogate {
  token: string;
  entityTag: string;
  surfaceTag: string;
}

export interface SurrogateStrategy {
  /** Deterministically mint the surrogate token for a value. `hint` steers typed surrogates; the
   *  opaque strategy ignores it. */
  mint(value: string, hint?: SurrogateHint): string;
  /** Present on strategies that can render context-bound registered entity families. */
  mintEntity?(input: EntitySurrogateInput): EntitySurrogate;
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
const ENTITY_TAG_LEN = 12;
const ENTITY_PATTERN_SOURCE = `${HEX_PREFIX}(?:ORG|PERSON)_[A-Z2-7]{${ENTITY_TAG_LEN}}_[A-Z2-7]{${ENTITY_TAG_LEN}}`;
const ENTITY_MAX_LENGTH = `${HEX_PREFIX}PERSON_${"A".repeat(ENTITY_TAG_LEN)}_${"A".repeat(ENTITY_TAG_LEN)}`.length;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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
 * Add context-bounded entity-family tokens while delegating every literal to the configured literal
 * strategy. The engine uses this wrapper by default; only trusted keyed scopes render entity records.
 */
export function entityFamilySurrogateStrategy(
  literal: SurrogateStrategy = surrogateStrategy(),
  key: string = DEFAULT_KEY,
): SurrogateStrategy {
  const pattern = new RegExp(`(?:${literal.pattern.source}|${ENTITY_PATTERN_SOURCE})`, "g");
  return {
    mint: (value, hint) => literal.mint(value, hint),
    mintEntity(input) {
      const type = input.entityType === "organization" ? "ORG" : "PERSON";
      const entityTag = hmacBase32(key, canonicalEncode("ficta.entity.v1", input.protectionContextId, input.entityId));
      const surfaceTag = hmacBase32(
        key,
        canonicalEncode("ficta.surface.v1", input.protectionContextId, input.entityId, input.exactSurface),
      );
      return {
        token: `${HEX_PREFIX}${type}_${entityTag}_${surfaceTag}`,
        entityTag,
        surfaceTag,
      };
    },
    pattern,
    maxLength: Math.max(literal.maxLength, ENTITY_MAX_LENGTH),
    isPotentialPrefix(text) {
      return literal.isPotentialPrefix(text) || isPotentialEntityPrefix(text);
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

function hmacBase32(key: string, payload: Uint8Array): string {
  const digest = createHmac("sha256", key).update(payload).digest();
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
      if (output.length === ENTITY_TAG_LEN) return output;
    }
  }
  throw new Error("HMAC digest was too short for an entity-family tag");
}

function canonicalEncode(...fields: string[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function isPotentialEntityPrefix(text: string): boolean {
  if (!text || text.length >= ENTITY_MAX_LENGTH) return false;
  for (const prefix of [`${HEX_PREFIX}ORG_`, `${HEX_PREFIX}PERSON_`]) {
    if (prefix.startsWith(text)) return true;
    if (!text.startsWith(prefix)) continue;
    const remainder = text.slice(prefix.length);
    if (remainder.length <= ENTITY_TAG_LEN) return /^[A-Z2-7]*$/u.test(remainder);
    return remainder[ENTITY_TAG_LEN] === "_" && /^[A-Z2-7]{12}_[A-Z2-7]{0,11}$/u.test(remainder);
  }
  return false;
}

// --- residual-surrogate detection ----------------------------------------------------------------

/**
 * An entity-family token reference a model invented or truncated: a complete entity tag with a
 * missing or invalid surface tag (e.g. a wildcard family reference like `FICTA_ORG_<entityTag>_*`).
 * The first alternative catches the tag followed by a dangling `_` (wildcard/truncation); the second
 * catches the bare tag, requiring a hard word boundary — no ASCII alphanumeric or underscore may
 * follow, so a tag embedded inside a longer identifier never matches. Shorter truncations (partial
 * tags) are deliberately out of scope: matching them would flag prose that merely mentions the token
 * prefix (e.g. documentation about ficta itself).
 */
const ENTITY_FRAGMENT_SOURCE =
  `${HEX_PREFIX}(?:ORG|PERSON)_[A-Z2-7]{${ENTITY_TAG_LEN}}` + `(?:_(?![A-Z2-7]{${ENTITY_TAG_LEN}})|(?![0-9A-Za-z_]))`;

/**
 * Longest text a residual candidate can span; streaming scans must see this much right context
 * beyond a candidate before classifying it (a shorter tail could still grow into a complete token).
 */
export const RESIDUAL_MAX_LENGTH = Math.max(ENTITY_MAX_LENGTH, TYPED_TOTAL);

/**
 * Matches every surrogate-shaped token ficta has ever emitted — opaque hex, typed, and entity-family
 * — plus entity-family fragments, independent of the active strategy (a transcript can echo tokens
 * minted under another style or process). Complete-entity precedes the fragment alternative so a
 * whole token is never classified as its own fragment. Fresh instance per call: global regexes are
 * stateful. Used only for post-restore residual observation; a match with no dictionary mapping is a
 * token the model mutated, truncated, or invented, reaching the client as-is.
 */
export function residualSurrogatePattern(): RegExp {
  const entity = ENTITY_PATTERN_SOURCE;
  const typed = `${HEX_PREFIX}[A-Z0-9]{1,${MAX_TYPE_LEN}}_[0-9a-f]{${HEX_LEN}}`;
  const hex = `${HEX_PREFIX}[0-9a-f]{${HEX_LEN}}`;
  return new RegExp(`(?:${entity}|${ENTITY_FRAGMENT_SOURCE}|${typed}|${hex})`, "g");
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
  "account-number": "ACCOUNT",
  "us-itin": "ID",
  "us-driver-license": "ID",
  "us-passport": "ID",
  id: "ID",
  "document-id": "ID",
  "medical-license": "ID",
  "za-id-number": "ID",
  "uk-nhs": "ID",
  "uk-nino": "ID",
  "uk-driving-licence": "ID",
  "uk-passport": "ID",
  "uk-vehicle-registration": "ID",
  "uk-postcode": "ADDRESS",
  // Secrets (specific shapes; the rest fall back to SECRET via kind)
  "private-key": "KEY",
  jwt: "JWT",
};
