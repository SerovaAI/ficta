import { envFlag, parseBoolean } from "../../env-flags.js";
import type { BodyLeaf, BodyLeafPath } from "../../vault.js";
import type { DetectorPlugin, PluginDiscovery, ProtectedValue } from "../types.js";

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
}

const MAX_GENERIC_VALUE_LENGTH = 512;
const MAX_PRIVATE_KEY_LENGTH = 8192;

const SECRETISH_NAME =
  /(?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)/i;

// Deliberately high-precision, prefix/format-anchored shapes. This mirrors the practical TruffleHog
// approach for request-time chat protection without live verification or entropy-only scanning.
const SECRET_SHAPE_PATTERNS: readonly SecretShapePattern[] = [
  {
    category: "private-key",
    regex: /-----\s*BEGIN[ A-Z0-9_-]*PRIVATE KEY\s*-----[\s\S]{32,8192}?-----\s*END[ A-Z0-9_-]*PRIVATE KEY\s*-----/gi,
    confidence: "high",
    validate: (value) => value.length <= MAX_PRIVATE_KEY_LENGTH,
  },
  {
    category: "jwt",
    regex: /\b([A-Za-z0-9_-]{12,}={0,2}\.[A-Za-z0-9_-]{12,}={0,2}\.[A-Za-z0-9_-]{12,})\b/g,
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
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>:]+:[^\s"'<>@]+@[^\s"'<>]+)\b/gi,
    confidence: "high",
  },
  {
    category: "secret-assignment",
    regex:
      /\b([A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)[A-Za-z0-9_.-]*)\b\s*[:=]\s*["'`]?([^\s"'`,;{}<>()[\]]+)["'`]?/gi,
    confidence: "probabilistic",
    validate: isLikelySecretValue,
  },
  {
    // JSON key→value pairs ({"api_key":"..."}) are detected structurally by detectSecretShapeLeaves;
    // the engine's structural join uses a non-whitespace boundary precisely so this pattern can never
    // fire across two leaves (an adjacent protocol key must not be capturable as a "value"). It still
    // matches key\nvalue lines *inside* one multi-line string leaf and on plain-text surfaces.
    category: "secret-json-value",
    regex:
      /\b([A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth)[A-Za-z0-9_.-]*)\b\s*\n\s*["'`]?([^\s"'`,;{}<>()[\]]+)["'`]?/gi,
    confidence: "probabilistic",
    validate: isLikelySecretValue,
  },
];

export function secretShapesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[ENV_ENABLED]);
}

export function resolveAgentSecretShapesEnabled(opts: {
  shellValue?: string;
  enabled?: string;
  agents?: string;
}): boolean {
  const explicit = parseBoolean(opts.shellValue);
  if (explicit !== undefined) return explicit;
  return envFlag(opts.enabled) && envFlag(opts.agents);
}

function addCandidate(
  out: ProtectedValue[],
  seen: Set<string>,
  category: string,
  raw: string,
  confidence: ProtectedValue["confidence"],
): void {
  const value = trimCandidate(raw);
  if (!value || seen.has(value) || isPlaceholder(value) || value.startsWith("FICTA_")) return;
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
      addCandidate(out, seen, pattern.category, value, pattern.confidence);
    }
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
      [ENV_ENABLED]: "0",
      [ENV_AGENTS]: "0",
    },
    bindings: [
      { env: ENV_ENABLED, path: ["secret_shapes", "enabled"], kind: "boolean" },
      { env: ENV_AGENTS, path: ["secret_shapes", "agents"], kind: "boolean" },
    ],
    sections: [{ path: ["secret_shapes"], keys: ["enabled", "agents"] }],
  },
  setup: {
    registrySources: () => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label:
          "Secret-shape detection — best-effort redaction of pasted API keys, JWTs, private keys, and credential URLs (web/standalone proxy; coding-agent launches opt in separately)",
        defaultEnabled: secretShapesEnabled() || process.env[ENV_ENABLED] !== "0",
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: () => [discoverSecretShapes()],
  detectText(text, ctx) {
    if (!text || !secretShapesEnabled()) return [];
    return detectSecretShapes(text, { header: ctx.header });
  },
  detectBodyLeaves(leaves) {
    if (!secretShapesEnabled()) return [];
    return detectSecretShapeLeaves(leaves);
  },
};

function discoverSecretShapes(): PluginDiscovery {
  if (!secretShapesEnabled()) {
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
      "active — matches known API key, token, JWT, private-key, credential-URL, and secret-assignment shapes; tokenized on egress and restored on responses",
  };
}

function isLikelySecretValue(raw: string): boolean {
  const value = trimCandidate(raw);
  if (value.length < 12 || value.length > MAX_GENERIC_VALUE_LENGTH) return false;
  if (isPlaceholder(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s"'<>:]+:[^\s"'<>@]+@[^\s"'<>]+$/i.test(value)) return true;
  if (SECRET_SHAPE_PATTERNS.slice(1, -2).some((pattern) => pattern.regex.test(value))) {
    resetPatternState();
    return true;
  }
  resetPatternState();
  if (/^(?:true|false|null|undefined|none|password|secret|token|example|changeme)$/i.test(value)) return false;
  if (/^[a-z][a-z0-9-]*$/i.test(value) && value.length < 20) return false;
  // Code references, not secrets: dotted identifier chains (localStorage.getItem,
  // envData.ADMIN_JWT_SECRET) and bare mixed-case identifiers with no digits (getValidApiKeys).
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !/\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value)) return false;

  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(
    Boolean,
  ).length;
  if (classes < 2) return false;
  return new Set(value).size >= 8;
}

function trimCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[`"'{(<[]+/, "")
    .replace(/[`"'}\])>,.;:]+$/, "");
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

function resetPatternState(): void {
  for (const pattern of SECRET_SHAPE_PATTERNS) pattern.regex.lastIndex = 0;
}
