import { envFlag, parseBoolean } from "../../env-flags.js";
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
    // JSON request detection runs over redactable string leaves joined with "\n", so object key/value
    // pairs such as {"api_key":"..."} are visible as "api_key\n...".
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

export function detectSecretShapes(text: string, ctx: { header?: string } = {}): ProtectedValue[] {
  if (!text) return [];

  const out: ProtectedValue[] = [];
  const seen = new Set<string>();
  const add = (category: string, raw: string, confidence: ProtectedValue["confidence"]) => {
    const value = trimCandidate(raw);
    if (!value || seen.has(value) || isPlaceholder(value) || value.startsWith("FICTA_")) return;
    seen.add(value);
    out.push({ name: category, value, source: "secret-shape", plugin: PLUGIN_NAME, kind: "secret", confidence });
  };

  for (const pattern of SECRET_SHAPE_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[2] ?? match[1] ?? match[0];
      if (!value) continue;
      if (pattern.validate && !pattern.validate(value)) continue;
      add(pattern.category, value, pattern.confidence);
    }
  }

  const header = ctx.header?.trim();
  if (header && SECRETISH_NAME.test(header)) {
    const value = trimCandidate(text.trim());
    if (isLikelySecretValue(value)) add("secret-header", value, "probabilistic");
  }

  return out;
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
