import { type EnvSource, envEnabled, parseBoolean } from "../../env-flags.js";
import type { BodyLeaf, BodyLeafPath } from "../../vault.js";
import type { DetectorPlugin, PluginDiscovery, PluginRuntime, ProtectedValue } from "../types.js";

const PLUGIN_NAME = "secret-shapes";
const ENV_ENABLED = "FICTA_SECRET_SHAPES_ENABLED";
const ENV_AGENTS = "FICTA_SECRET_SHAPES_AGENTS";

interface SecretShapePattern {
  /** Safe category label used as ProtectedValue.name. Never the matched value. */
  category: string;
  /** Global regex. Group 1 is used when present; otherwise the whole match is protected. */
  regex: RegExp;
  confidence: ProtectedValue["confidence"];
  validate?: (value: string) => boolean;
  /**
   * Which part of a candidate the placeholder filter (`isPlaceholder`) inspects. Defaults to the
   * whole value; a structural shape can narrow it (a credential URL to its password) or opt out
   * (a PEM block), so a real secret is not skipped because its hostname or base64 body happens to
   * contain a word like "your" or "xxx".
   */
  placeholderText?: (value: string) => string;
}

const MAX_GENERIC_VALUE_LENGTH = 512;
const MAX_PRIVATE_KEY_LENGTH = 8192;

const SECRETISH_NAME =
  /(?:api[_-]?key|token|secret|password|passwd|pwd|passwort|kennwort|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)/i;

// Deliberately high-precision, prefix/format-anchored shapes. This mirrors the practical TruffleHog
// approach for request-time chat protection without live verification or entropy-only scanning.
const SECRET_SHAPE_PATTERNS: readonly SecretShapePattern[] = [
  {
    category: "private-key",
    regex: /-----\s*BEGIN[ A-Z0-9_-]*PRIVATE KEY\s*-----[\s\S]{32,8192}?-----\s*END[ A-Z0-9_-]*PRIVATE KEY\s*-----/gi,
    confidence: "high",
    validate: (value) => value.length <= MAX_PRIVATE_KEY_LENGTH,
    // A PEM body is base64: a substring like "xxx" or "Your" is noise, not a placeholder marker.
    placeholderText: () => "",
  },
  {
    category: "jwt",
    // Anchored on a character outside the token alphabet rather than `\b`: `-` is a non-word char,
    // so `\b` let a match start at every `-` inside one long base64url run, and each start scanned
    // to the end of the run (quadratic on a large blob). One start per run keeps it linear.
    regex: /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{12,}={0,2}\.[A-Za-z0-9_-]{12,}={0,2}\.[A-Za-z0-9_-]{12,})\b/g,
    confidence: "high",
    validate: isJwt,
  },
  {
    category: "openai-api-key",
    regex: /\b(sk-(?:(?:proj|svcacct|service|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{8,}T3BlbkFJ[A-Za-z0-9_-]{10,}))\b/g,
    confidence: "high",
  },
  {
    category: "anthropic-api-key",
    regex: /\b(sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{40,}AA)\b/g,
    confidence: "high",
  },
  {
    category: "github-token",
    regex: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{36,255})\b/g,
    confidence: "high",
  },
  {
    category: "gitlab-token",
    regex: /\b(glpat-[A-Za-z0-9\-=_]{27,300}\.[0-9a-z]{2}\.[a-z0-9]{9}|glpat-[A-Za-z0-9\-=_]{20,22})\b/g,
    confidence: "high",
  },
  {
    category: "slack-token",
    regex: /\b(xox[abpr]-[A-Za-z0-9-]{20,})\b/g,
    confidence: "high",
  },
  {
    category: "stripe-api-key",
    regex: /\b([rs]k_(?:live|test)_[A-Za-z0-9]{20,247})\b/g,
    confidence: "high",
  },
  {
    category: "huggingface-token",
    regex: /\b((?:hf_|api_org_)[A-Za-z0-9]{34})\b/g,
    confidence: "high",
  },
  {
    category: "notion-token",
    regex: /\b(secret_[A-Za-z0-9]{43})\b/g,
    confidence: "high",
  },
  {
    category: "npm-token",
    regex: /\b(npm_[A-Za-z0-9]{36})\b/g,
    confidence: "high",
  },
  {
    category: "postman-api-key",
    regex: /\b(PMAK-[A-Za-z0-9-]{59})\b/g,
    confidence: "high",
  },
  {
    category: "google-api-key",
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    confidence: "high",
  },
  {
    category: "sendgrid-api-key",
    regex: /\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
    confidence: "high",
  },
  {
    category: "google-oauth-token",
    regex: /\b(ya29\.[A-Za-z0-9_-]{50,})(?![A-Za-z0-9_-])/g,
    confidence: "high",
  },
  {
    category: "aws-access-key-id",
    regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g,
    confidence: "high",
  },
  {
    category: "aws-secret-access-key",
    regex: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    confidence: "high",
  },
  {
    category: "credential-url",
    // The scheme run is bounded ({1,31}): an unbounded `[a-z0-9+.-]*` before `://` rescans to the end
    // of every dotted identifier run from each word boundary inside it (quadratic on large listings).
    // Userinfo cannot contain `/` (RFC 3986), so excluding it stops `http://localhost:3000/@vite/client`
    // from reading as user `localhost`, password `3000/`. U+0000 is the engine's leaf boundary: without
    // it the tail class swallows the next leaf and the candidate is rejected as straddling two leaves.
    // eslint-disable-next-line no-control-regex -- U+0000 is the engine structural leaf delimiter.
    regex: /\b([a-z][a-z0-9+.-]{1,31}:\/\/[^\s\u0000"'<>:/]+:[^\s\u0000"'<>@/]+@[^\s\u0000"'<>]+)\b/gi,
    confidence: "high",
    validate: isLiteralCredentialUrl,
    placeholderText: (value) => credentialUrlPassword(value) ?? value,
  },
  {
    category: "secret-assignment",
    // The `["'`]?` after the key is what makes this work on JSON *text* — a quoted key
    // (`"api_token": "…"`) otherwise fails, because the closing quote sits between the key and the
    // separator and `\s*` cannot cross it. JSON request *bodies* are paired structurally by
    // detectSecretShapeLeaves; this covers a JSON config an agent reads into a tool result.
    // The URI alternative deliberately retains template braces/parentheses so validation sees the
    // whole credential URL rather than a misleading `scheme://user:$` prefix.
    // The key runs are bounded ({0,64}) because an unbounded `[...]*` on both sides of the word
    // alternation backtracks quadratically over long dotted/dashed identifier runs. The value classes
    // exclude U+0000 (the engine's leaf boundary) so an unquoted value that ends its leaf is captured
    // as-is instead of swallowing the next leaf and being rejected as straddling two leaves.
    regex:
      // eslint-disable-next-line no-control-regex -- U+0000 is the engine structural leaf delimiter.
      /\b([A-Za-z][A-Za-z0-9_.-]{0,64}(?:api[_-]?key|token|secret|password|passwd|pwd|passwort|kennwort|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)[A-Za-z0-9_.-]{0,64})\b["'`]?\s*[:=]\s*["'`]?((?:[a-z][a-z0-9+.-]{1,31}:\/\/[^\s\u0000"'`,;<>]+|[^\s\u0000"'`,;{}<>()[\]]+))["'`]?/gi,
    confidence: "probabilistic",
    validate: isLikelySecretValue,
  },
  {
    // A password word used as a label in prose or a message: `Password: hunter2`, `pwd=…`,
    // `send the deck, password: s3cret!, by Thursday`. Unlike secret-assignment this accepts the word
    // at the very start of the key and short values, so it is limited to password words (English and
    // German) and validated by isLikelyLabelledPassword, which rejects the code shapes these labels
    // also introduce (type annotations, identifiers, paths, template variables, masked values).
    category: "password-label",
    regex:
      // eslint-disable-next-line no-control-regex -- U+0000 is the engine structural leaf delimiter.
      /\b(password|passwd|pwd|passwort|kennwort)\b["'`]?[ \t]*[:=][ \t]*["'`]?([^\s\u0000"'`,;{}<>()[\]]+)["'`]?/gi,
    confidence: "probabilistic",
    validate: isLikelyLabelledPassword,
  },
  {
    // JSON key→value pairs ({"api_key":"..."}) are detected structurally by detectSecretShapeLeaves;
    // the engine's structural join uses a non-whitespace boundary precisely so this pattern can never
    // fire across two leaves (an adjacent protocol key must not be capturable as a "value"). It still
    // matches key\nvalue lines *inside* one multi-line string leaf and on plain-text surfaces.
    category: "secret-json-value",
    regex:
      // eslint-disable-next-line no-control-regex -- U+0000 is the engine structural leaf delimiter.
      /\b([A-Za-z][A-Za-z0-9_.-]{0,64}(?:api[_-]?key|token|secret|password|passwd|pwd|passwort|kennwort|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)[A-Za-z0-9_.-]{0,64})\b\s*\n\s*["'`]?((?:[a-z][a-z0-9+.-]{1,31}:\/\/[^\s\u0000"'`,;<>]+|[^\s\u0000"'`,;{}<>()[\]]+))["'`]?/gi,
    confidence: "probabilistic",
    validate: isLikelySecretValue,
  },
];

/**
 * The structurally-anchored shapes (vendor prefixes, JWT, PEM, credential URL): a value matching one
 * of these is a secret regardless of the key it sits under. The two probabilistic key/value pairing
 * patterns are excluded — they are the callers of this check, not evidence for it.
 */
const KNOWN_SHAPE_PATTERNS = SECRET_SHAPE_PATTERNS.filter((pattern) => pattern.confidence === "high");

/** Parse the secret-shapes enable flag from env-style settings (default on). */
export function secretShapesEnabled(env: EnvSource): boolean {
  return envEnabled(env[ENV_ENABLED], true);
}

export function resolveAgentSecretShapesEnabled(opts: {
  shellValue?: string;
  enabled?: string;
  agents?: string;
}): boolean {
  const explicit = parseBoolean(opts.shellValue);
  if (explicit !== undefined) return explicit;
  return envEnabled(opts.enabled, true) && envEnabled(opts.agents, true);
}

function addCandidate(
  out: ProtectedValue[],
  seen: Set<string>,
  category: string,
  raw: string,
  confidence: ProtectedValue["confidence"],
  placeholderText: (value: string) => string = (value) => value,
): void {
  const value = trimCandidate(raw);
  if (!value || seen.has(value) || isPlaceholder(placeholderText(value)) || value.startsWith("FICTA_")) return;
  // A candidate containing the engine's structural leaf boundary (U+0000) straddles two JSON
  // leaves — by construction never one real value, so registering it could only corrupt requests.
  if (value.includes("\u0000")) return;
  seen.add(value);
  out.push({ name: category, value, source: "secret-shape", plugin: PLUGIN_NAME, kind: "secret", confidence });
}

export function detectSecretShapes(text: string, ctx: { header?: string } = {}): ProtectedValue[] {
  if (!text) return [];

  const out: ProtectedValue[] = [];
  const seen = new Set<string>();

  for (const pattern of SECRET_SHAPE_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[2] ?? match[1] ?? match[0];
      if (!value) continue;
      if (pattern.validate && !pattern.validate(value)) continue;
      addCandidate(out, seen, pattern.category, value, pattern.confidence, pattern.placeholderText);
    }
  }

  // Whole whitespace/quote-delimited candidates only: never extract a digest from a path,
  // dotted identifier, URL, or a longer value. U+0000 delimits leaves but cannot occur inside a candidate.
  // eslint-disable-next-line no-control-regex -- U+0000 is the engine structural leaf delimiter.
  for (const match of text.matchAll(/(?<![^\s\u0000"'`])([A-Za-z0-9_+/-]{32,512}={0,2})(?![^\s\u0000"'`])/g)) {
    const value = match[1]!;
    if (isLabelledDigest(value, text, match.index)) continue;
    if (isOpaqueSecret(value)) addCandidate(out, seen, "opaque-secret", value, "probabilistic");
  }

  const header = ctx.header?.trim();
  if (header && SECRETISH_NAME.test(header)) {
    const value = trimCandidate(text.trim());
    if (isLikelySecretValue(value)) addCandidate(out, seen, "secret-header", value, "probabilistic");
  }

  return out;
}

/** First token of a leaf's text, mirroring the value side of the assignment/json-value patterns. */
const LEADING_VALUE_TOKEN = /^\s*["'`]?([^\s"'`,;{}<>()[\]]+)/;

/**
 * Structural JSON detection: pair a secret-ish object key with its *own* string value (or the
 * string elements of its direct array value) using leaf paths. The joined-text view cannot express
 * this safely — a non-string value emits no leaf, so `{"max_tokens": 64000, "output_config": ...}`
 * put two keys adjacent in the join and the json-value regex registered the protocol key
 * `output_config` as a secret, corrupting every later request through the proxy.
 */
export function detectSecretShapeLeaves(leaves: readonly BodyLeaf[]): ProtectedValue[] {
  const out: ProtectedValue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < leaves.length; i++) {
    const key = leaves[i];
    if (key?.kind !== "key" || !SECRETISH_NAME.test(key.text)) continue;
    for (let j = i + 1; j < leaves.length; j++) {
      const leaf = leaves[j];
      if (!leaf || !isWithinSubtree(key.path, leaf.path)) break;
      // Descendants of nested objects/arrays get their own key-pairing pass; skip them but keep
      // scanning — in a mixed array a direct string element can follow a nested element.
      if (leaf.kind !== "value" || !isOwnValuePath(key.path, leaf.path)) continue;
      const token = LEADING_VALUE_TOKEN.exec(leaf.text)?.[1];
      if (token !== undefined && isLikelySecretValue(token)) {
        addCandidate(out, seen, "secret-json-value", token, "probabilistic");
      }
    }
  }
  return out;
}

/** True when `path` is the key's own value position or anywhere inside the key's subtree. */
function isWithinSubtree(keyPath: BodyLeafPath, path: BodyLeafPath): boolean {
  if (path.length < keyPath.length) return false;
  for (let i = 0; i < keyPath.length; i++) if (path[i] !== keyPath[i]) return false;
  return true;
}

/** The value leaf that belongs to `keyPath`: the key's own string value, or a direct array element. */
function isOwnValuePath(keyPath: BodyLeafPath, valuePath: BodyLeafPath): boolean {
  const direct = valuePath.length === keyPath.length;
  const element = valuePath.length === keyPath.length + 1 && typeof valuePath[valuePath.length - 1] === "number";
  if (!direct && !element) return false;
  for (let i = 0; i < keyPath.length; i++) if (valuePath[i] !== keyPath[i]) return false;
  return true;
}

export const secretShapesPlugin: DetectorPlugin = {
  kind: "detector",
  name: PLUGIN_NAME,
  description: "Best-effort request-time detection of known secret token shapes",
  config: {
    envDefaults: {
      [ENV_ENABLED]: "1",
      [ENV_AGENTS]: "1",
    },
    bindings: [
      { env: ENV_ENABLED, path: ["secret_shapes", "enabled"], kind: "boolean" },
      { env: ENV_AGENTS, path: ["secret_shapes", "agents"], kind: "boolean" },
    ],
    sections: [{ path: ["secret_shapes"], keys: ["enabled", "agents"] }],
  },
  setup: {
    registrySources: (ctx) => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label:
          "Secret-shape detection — best-effort redaction of pasted API keys, JWTs, private keys, opaque values, and credential URLs (on by default for web, standalone proxy, and coding agents)",
        defaultEnabled: secretShapesEnabled(ctx.env),
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: (runtime) => [discoverSecretShapes(runtime)],
  detectText(text, ctx) {
    if (!text || !ctx.runtime.config.secretShapes.enabled) return [];
    return detectSecretShapes(text, { header: ctx.header });
  },
  detectBodyLeaves(leaves, ctx) {
    if (!ctx.runtime.config.secretShapes.enabled) return [];
    return detectSecretShapeLeaves(leaves);
  },
};

function discoverSecretShapes(runtime: PluginRuntime): PluginDiscovery {
  if (!runtime.config.secretShapes.enabled) {
    return {
      id: `${PLUGIN_NAME}/detector`,
      plugin: PLUGIN_NAME,
      label: "Secret-shape detector",
      status: "disabled",
      message: `disabled — set ${ENV_ENABLED}=1 (secret_shapes.enabled=true) for request-time detection; coding-agent launches also need ${ENV_AGENTS}=1 (secret_shapes.agents=true) unless explicitly overridden`,
    };
  }
  return {
    id: `${PLUGIN_NAME}/detector`,
    plugin: PLUGIN_NAME,
    label: "Secret-shape detector",
    status: "active",
    message:
      "active — matches known API key, token, JWT, private-key, credential-URL, secret-assignment, and probabilistic opaque-value shapes; tokenized on egress and restored on responses",
  };
}

/** Opaque credentials have no unique signature; these checks deliberately remain probabilistic. */
function isOpaqueSecret(value: string): boolean {
  if (value.length > MAX_GENERIC_VALUE_LENGTH || isPlaceholder(value) || value.startsWith("FICTA_")) return false;
  if (isPathShaped(value)) return false;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  // Hex session credentials overlap with hashes: do not claim that these are verified secrets.
  if (/^[a-f0-9]{40,512}$/i.test(value)) return /[a-f]/i.test(value) && /\d/.test(value) && entropy >= 3.3;
  // Require mixed case and digits to avoid long words, snake_case constants, and most identifiers.
  // The entropy bar scales with length below 40 chars: a 32-char value has at most 32 distinct
  // characters (5 bits), and a flat 4.5-bit bar rejected a third of genuinely random 32-char tokens.
  const threshold = Math.min(4.5, 0.85 * Math.log2(value.length));
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy >= threshold;
}

/**
 * A label that names the following value as a digest: `sha256: …`, `"commit": "…"`, `checksum=…`,
 * `enrichment_skill_sha256: …`, `commit …` (git log). The digest word must end the key, so
 * `hash_secret` or `digest_token` is not a digest label.
 */
const DIGEST_LABEL =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])*(?:sha(?:1|224|256|384|512)?|sha3(?:[_-]?\d{3})?|md5|blake2b?|blake3|hash|digest|checksum|commit|etag|integrity|oid)["'`]?[ \t]*[:=]?[ \t]*["'`]?$/i;

/** Longest line prefix read for a digest label; a longer prefix is never exempted. */
const MAX_DIGEST_LABEL_LINE = 160;

/** Subresource Integrity values (`sha512-<base64>`) carry their own label and an exact length. */
const SRI_DIGEST = /^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/;

/**
 * Hex digests (commit SHAs, content hashes, checksums) are indistinguishable from hex session
 * credentials by shape, so a bare one is still treated as opaque. When the text immediately before
 * it on the same line labels it as a digest, it is a hash the agent needs verbatim — rewriting it
 * breaks exact-match edits and checksum verification — and is skipped.
 *
 * The label must sit in the same leaf and on the same line: joined body text separates keys and
 * values with U+0000 without saying which is which, so a prose value ending in "hash" must not
 * vouch for the next leaf. The whole line prefix (not just the label) must be free of secret-ish
 * names (`api_key_sha256:`, `session token hash:`), and an over-long prefix is not exempted, so a
 * secret-ish word can never fall outside the inspected text.
 */
function isLabelledDigest(value: string, text: string, index: number): boolean {
  if (SRI_DIGEST.test(value)) return true;
  if (!/^[a-f0-9]{32,512}$/i.test(value)) return false;
  const lineStart = Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf("\u0000", index - 1)) + 1;
  if (index - lineStart > MAX_DIGEST_LABEL_LINE) return false;
  const line = text.slice(lineStart, index);
  return DIGEST_LABEL.test(line) && !SECRETISH_NAME.test(line);
}

function isLikelySecretValue(raw: string): boolean {
  const value = trimCandidate(raw);
  if (value.length < 12 || value.length > MAX_GENERIC_VALUE_LENGTH) return false;
  if (isPlaceholder(value)) return false;
  if (credentialUrlPassword(value) !== undefined) return isLiteralCredentialUrl(value);
  if (KNOWN_SHAPE_PATTERNS.some((pattern) => matchesValidatedShape(value, pattern))) return true;
  if (/^(?:true|false|null|undefined|none|password|secret|token|example|changeme)$/i.test(value)) return false;
  // Filesystem paths, not secrets. Must come after the credential-URL and known-shape checks above
  // so a credential URL (which contains slashes) still wins. Without this, the separator-less
  // `secret-json-value` branch swallows the path on the line after any token containing a
  // secret-ish word (`.../rotateToken`, `useAuth.ts`, a comment ending `(registered-secret`),
  // which silently deletes ~1 path per 150 from any file listing an agent reads.
  if (isPathShaped(value)) return false;
  if (/^[a-z][a-z0-9-]*$/i.test(value) && value.length < 20) return false;
  // Code references, not secrets: dotted identifier chains (localStorage.getItem,
  // envData.ADMIN_JWT_SECRET) and bare mixed-case identifiers with no digits (getValidApiKeys).
  // The chain tolerates optional chaining (`env.FOO?.trim`) and a trailing TypeScript non-null
  // assertion (`process.env.BAR!`): both are outside `[\w$]`, so without this the expression reads
  // as an opaque high-entropy value and gets redacted out of the source the agent is reading.
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+!?$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*!?$/.test(value) && !/\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value)) {
    return false;
  }

  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(
    Boolean,
  ).length;
  if (classes < 2) return false;
  return new Set(value).size >= 8;
}

/**
 * The value after a password label. Short passwords are allowed, so this leans on shape instead of
 * length: the value must carry a digit or a symbol (a bare word after `password:` is far more often
 * a type, keyword, or variable name than a password) and must not look like code, a path, a template
 * variable, a YAML tag, or a masked value.
 */
function isLikelyLabelledPassword(raw: string): boolean {
  const value = trimCandidate(raw);
  if (value.length < 4 || value.length > MAX_GENERIC_VALUE_LENGTH) return false;
  if (isPlaceholder(value)) return false;
  // Masked or symbol-only values (`********`, `---`) carry nothing to protect.
  if (!/[A-Za-z0-9]/.test(value)) return false;
  // A bare word or snake/camel identifier with no digit: `string`, `None`, `new_password`, `getpass`.
  if (/^[A-Za-z_$][\w$]*!?$/.test(value) && !/\d/.test(value)) return false;
  // Typed-array names are the one common type annotation that carries a digit (`password: Uint8Array`).
  if (/^(?:Big)?(?:Ui|I)nt\d+(?:Clamped)?Array$|^Float\d+Array$/.test(value)) return false;
  // Dotted chains (`req.body.password`, `process.env.DB_PASSWORD`) are code references.
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+!?$/.test(value)) return false;
  // Paths, including the absolute working directory that `PWD=/…` shows in an environment dump.
  if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:\\)/.test(value) || isPathShaped(value)) return false;
  if (isCredentialTemplate(value)) return false;
  // YAML tags such as `!secret db_password` or `!Ref DbPassword` reference a value stored elsewhere.
  if (/^![A-Za-z]+$/.test(value)) return false;
  return true;
}

/**
 * A URI whose password is entirely a source-language template references a credential at runtime
 * but does not contain one in the text the agent read. Redacting it only hides usable source code,
 * and an echoed surrogate can later be written back to disk. Keep detecting literal passwords,
 * including values that merely contain `$` or braces; only whole, unambiguous variable expressions
 * are excluded.
 */
function isLiteralCredentialUrl(value: string): boolean {
  const password = credentialUrlPassword(value);
  return password !== undefined && !isCredentialTemplate(password);
}

function credentialUrlPassword(value: string): string | undefined {
  return /^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s"'<>:/]+:([^\s"'<>@/]+)@[^\s"'<>]+$/i.exec(value)?.[1];
}

function isCredentialTemplate(value: string): boolean {
  return /^(?:\$\{[A-Za-z_][A-Za-z0-9_.-]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\([A-Za-z_][A-Za-z0-9_.-]*\)|\{\{[A-Za-z_][A-Za-z0-9_.-]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%)$/.test(
    value,
  );
}

function matchesValidatedShape(text: string, pattern: SecretShapePattern): boolean {
  pattern.regex.lastIndex = 0;
  for (const match of text.matchAll(pattern.regex)) {
    const value = match[2] ?? match[1] ?? match[0];
    if (value && (!pattern.validate || pattern.validate(value))) return true;
  }
  return false;
}

function trimCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[`"'{(<[]+/, "")
    .replace(/[`"'}\])>,.;:]+$/, "");
}

/** Shortest run of unbroken mixed-case-plus-digits we read as credential material, not a filename. */
const MIN_CREDENTIAL_SEGMENT_LENGTH = 20;

/**
 * True when a path segment looks like credential material rather than a filename: a long unbroken
 * run mixing letter cases and digits. Real filenames that long carry a separator (`.`, `-`, `_`) —
 * including content-hashed assets like `app.4f3a2b1c9d8e.js` — so requiring an unbroken run keeps
 * them on the path side while catching a slash-containing token such as
 * `Xk9sQ2mZ7pL4vN8rT1wY6hB3jF5dG0cA2eR7uI4o/S`.
 */
function isCredentialLikeSegment(segment: string): boolean {
  if (segment.length < MIN_CREDENTIAL_SEGMENT_LENGTH) return false;
  if (/[._-]/.test(segment)) return false;
  return /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment);
}

/**
 * True for multi-segment filesystem paths (`apps/web/app/settings/page.tsx`), optionally carrying a
 * grep/ripgrep locator suffix (`src/defaults.ts:12`, `src/defaults.ts:12:9`). Deliberately narrow:
 * a single-segment value is never path-shaped, `+` and `=` are excluded from the char class so
 * base64 credentials stay detectable, and one credential-like segment disqualifies the whole value
 * so a slash-containing secret is not mistaken for a path.
 */
function isPathShaped(value: string): boolean {
  if (!/^[A-Za-z0-9_.@~$%-]+(?:\/[A-Za-z0-9_.@~$%-]+)+\/?(?::\d+)*:?$/.test(value)) return false;
  return !value
    .replace(/(?::\d+)*:?$/, "")
    .split("/")
    .some(isCredentialLikeSegment);
}

function isPlaceholder(value: string): boolean {
  return /(?:example|sample|dummy|fake|placeholder|your[_-]?|xxx|redacted|changeme|replace[_-]?me)/i.test(value);
}

function isJwt(value: string): boolean {
  const [header, payload, signature] = value.split(".");
  if (!header || !payload || !signature) return false;
  if (signature.length < 12) return false;
  const decodedHeader = parseBase64UrlJson(header);
  const decodedPayload = parseBase64UrlJson(payload);
  if (!isRecord(decodedHeader) || !isRecord(decodedPayload)) return false;
  return typeof decodedHeader.alg === "string" || String(decodedHeader.typ ?? "").toUpperCase() === "JWT";
}

function parseBase64UrlJson(segment: string): unknown {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
