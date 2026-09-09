import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import {
  detectSecretShapes,
  type ProtectedValue,
  resolveAgentSecretShapesEnabled,
  secretShapesPlugin,
} from "../src/plugins/index.js";

const OPENAI = ["sk", "proj", "abc123def456ghi789T3BlbkFJabcdefghijklmno"].join("-");
const GITHUB = ["ghp", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234"].join("_");
const SLACK = ["xoxb", "123456789012", "123456789012", "abcdefABCDEF"].join("-");
const STRIPE = ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30";
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCu",
  "-----END PRIVATE KEY-----",
].join("\n");
const GENERIC_SECRET = "aB3dE5fG7hJ9kLmN2pQr";

describe("secret-shape detector", () => {
  it("stays on the detector boundary, not the exact-value registry-source boundary", () => {
    expect(secretShapesPlugin.kind).toBe("detector");
    expect("loadValues" in secretShapesPlugin).toBe(false);
    expect(secretShapesPlugin.name).toBe("secret-shapes");
    expect(secretShapesPlugin.config?.sections).toEqual([{ path: ["secret_shapes"], keys: ["enabled", "agents"] }]);
  });

  it("detects known token shapes without pre-registration", () => {
    const found = detectSecretShapes(
      [`OpenAI ${OPENAI}`, `GitHub ${GITHUB}`, `Slack ${SLACK}`, `Stripe ${STRIPE}`, `JWT ${JWT}`, PRIVATE_KEY].join(
        "\n",
      ),
    );
    const values = new Set(found.map((value) => value.value));

    expect(values).toContain(OPENAI);
    expect(values).toContain(GITHUB);
    expect(values).toContain(SLACK);
    expect(values).toContain(STRIPE);
    expect(values).toContain(JWT);
    expect(values).toContain(PRIVATE_KEY);
    for (const value of found) expect(value.kind).toBe("secret");
  });

  it("detects secret-ish assignments and JSON key/value leaves", async () => {
    const assignment = detectSecretShapes(`CUSTOM_API_TOKEN=${GENERIC_SECRET}`);
    expect(assignment.map((value) => value.value)).toContain(GENERIC_SECRET);

    const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const body = JSON.stringify({ api_token: GENERIC_SECRET });
      const redacted = await engine.redactBodyDetailed(body);

      expect(redacted.count).toBe(1);
      expect(redacted.leaks).toBe(0);
      expect(redacted.body).not.toContain(GENERIC_SECRET);
      expect(engine.restoreJson(redacted.body)).toContain(GENERIC_SECRET);
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });

  it("is active by default and respects explicit opt-out", async () => {
    delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    expect(await secretShapesPlugin.detectText(OPENAI, { surface: "body" })).not.toEqual([]);
    process.env.FICTA_SECRET_SHAPES_ENABLED = "0";
    expect(await secretShapesPlugin.detectText(OPENAI, { surface: "body" })).toEqual([]);
    expect(secretShapesPlugin.discover?.()[0]?.status).toBe("disabled");

    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const found = (await secretShapesPlugin.detectText(OPENAI, { surface: "body" })) as ProtectedValue[];
      expect(found.map((value) => value.value)).toEqual([OPENAI]);
      expect(secretShapesPlugin.discover?.()[0]?.status).toBe("active");
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });

  it("round-trips a pasted secret through the scoped engine layer", async () => {
    process.env.FICTA_SECRET_SHAPES_ENABLED = "1";
    try {
      const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
      const scope = engine.beginRequest("org:thread");
      const body = JSON.stringify({ messages: [{ role: "user", content: `new key ${OPENAI}` }] });

      const redacted = await scope.redactBodyDetailed(body);
      expect(redacted.count).toBe(1);
      expect(redacted.leaks).toBe(0);
      expect(redacted.body).not.toContain(OPENAI);
      expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(scope.restoreJson(redacted.body)).toContain(OPENAI);
    } finally {
      delete process.env.FICTA_SECRET_SHAPES_ENABLED;
    }
  });

  it("does not redact credential URLs whose password is only a template variable", () => {
    const schemeSeparator = [":", "//"].join("");
    const credentialUrl = (password: string) =>
      `postgresql${schemeSeparator}serova:${password}@database.internal.test/application`;
    const shellVariable = (name: string) => ["$", "{", name, "}"].join("");
    const templates = [
      shellVariable("DB_PASSWORD"),
      "$DB_PASSWORD",
      "$(DB_PASSWORD)",
      "{{db_password}}",
      "%DB_PASSWORD%",
    ];

    for (const template of templates) {
      expect(detectSecretShapes(`TARGET_URL="${credentialUrl(template)}"`)).toEqual([]);
      expect(detectSecretShapes(`DATABASE_PASSWORD="${credentialUrl(template)}"`)).toEqual([]);
    }

    const incidentShape =
      `postgresql${schemeSeparator}serova:${shellVariable("pass")}@${shellVariable("host")}:` +
      `${shellVariable("port")}/${shellVariable("TARGET_DB")}?sslmode=require`;
    expect(detectSecretShapes(`TARGET_URL="${incidentShape}"`)).toEqual([]);

    const literal = credentialUrl("actual-$-literal-pass-123");
    expect(detectSecretShapes(literal)).toEqual([
      expect.objectContaining({ name: "credential-url", value: literal, confidence: "high" }),
    ]);
  });

  it("does not treat code references as secret-assignment values", () => {
    // Dotted identifier chains and bare mixed-case identifiers are code, not secrets. The value
    // char class also stops before a call/index expression so `foo(` never enters the candidate.
    const cases = [
      "const secret = envData.ADMIN_JWT_SECRET",
      "const token = localStorage.getItem('admin_token')",
      "const authToken = getAuthorizationTokenValue",
      // Optional chaining and non-null assertions sit outside `[\w$]`, so without explicit
      // tolerance these read as opaque high-entropy values and get redacted out of the source.
      "const token = config.auth?.accessToken",
      "const secret = options?.client?.clientSecret",
      "const apiKey = process.env.SERVICE_API_KEY!",
      "const password = creds.db?.password!",
    ];
    for (const source of cases) {
      expect(detectSecretShapes(source)).toEqual([]);
    }
  });

  it("does not swallow file paths on the line after a secret-ish token", () => {
    // The `secret-json-value` branch needs no separator between key and value, so before the
    // path-shape guard any listing whose previous line ended in a token containing `token`/
    // `secret`/`auth` lost the entire next path — silently, and only in that position.
    const listings = [
      ["convex/lib/rotateToken", "apps/web/app/settings/page.tsx"],
      ["apps/web/hooks/useAuth.ts", "packages/core/src/index.ts"],
      ["// falls back to the registered-secret", "packages/ficta/src/defaults.ts:12:  const x = 1;"],
      ["gated behind oauth", "apps/gateway/src/server.ts"],
      ["src/routes/api/v1/authToken.ts", "src/routes/api/v1/$.ts"],
    ];
    for (const lines of listings) {
      expect(detectSecretShapes(lines.join("\n"))).toEqual([]);
    }
  });

  it("still pairs a bare secret-ish key with a credential on the next line", () => {
    // The path guard must not disarm the separator-less branch for real credentials, including
    // base64 (excluded from the path char class via `+`/`=`) and slash-containing values.
    const credentials = ["aB3/xY9z+Qw1RtU7pLmN2vK4hJ6gF8dS0cE5bA==", "Xk9sQ2mZ7pL4vN8rT1wY6hB3jF5dG0cA2eR7uI4o/S"];
    for (const credential of credentials) {
      const found = detectSecretShapes(["API_TOKEN", credential].join("\n"));
      expect(found.map((value) => value.value)).toContain(credential);
    }
  });

  it("pairs a quoted key with its value on a text surface", () => {
    // JSON read into a tool result is text, not a body, so detectSecretShapeLeaves never sees it.
    // An opaque value with no vendor shape isolates the key-pairing branch: only the quote
    // tolerance can catch these.
    const opaque = "aB3xY9zQw1RtU7pLmN2vK4hJ6gF8dS0cE5bA7nP2";
    const surfaces = [
      `{"api_token": "${opaque}"}`,
      ["{", `  "api_token": "${opaque}"`, "}"].join("\n"),
      [`  "api_token":`, `    "${opaque}"`].join("\n"),
      `'api_token': ${opaque}`,
    ];
    for (const surface of surfaces) {
      expect(detectSecretShapes(surface).map((value) => value.value)).toContain(opaque);
    }
  });

  it("still detects a real key inside a secret-ish assignment", () => {
    const found = detectSecretShapes(`API_KEY=${OPENAI}`);
    expect(found.map((value) => value.value)).toContain(OPENAI);
  });
});

describe("resolveAgentSecretShapesEnabled", () => {
  it("defaults on for agents and respects either opt-out", () => {
    expect(resolveAgentSecretShapesEnabled({})).toBe(true);
    expect(resolveAgentSecretShapesEnabled({ enabled: "1" })).toBe(true);
    expect(resolveAgentSecretShapesEnabled({ enabled: "1", agents: "1" })).toBe(true);
    expect(resolveAgentSecretShapesEnabled({ enabled: "0" })).toBe(false);
    expect(resolveAgentSecretShapesEnabled({ agents: "false" })).toBe(false);
  });

  it("lets an explicit shell value win", () => {
    expect(resolveAgentSecretShapesEnabled({ shellValue: "1", enabled: "0", agents: "0" })).toBe(true);
    expect(resolveAgentSecretShapesEnabled({ shellValue: "0", enabled: "1", agents: "1" })).toBe(false);
  });
});

describe("secret-shape detector regressions (engine review)", () => {
  const schemeSeparator = [":", "//"].join("");
  const password = ["hunter2", "hunter2", "!!"].join(""); // 16 chars, mixed classes, not opaque-shaped
  const credentialUrl = `postgresql${schemeSeparator}deploy:${password}@db.internal.test/app`;

  async function bodyCount(messages: unknown[]): Promise<number> {
    const engine = new ProtectionEngine({ plugins: [secretShapesPlugin] });
    return (await engine.beginRequest().redactBodyDetailed(JSON.stringify({ messages }))).count;
  }

  it("captures an unquoted assignment or credential URL that ends a body leaf", async () => {
    // The structural body view joins leaves with U+0000. The value classes used to run across that
    // boundary into the next leaf, and the straddling candidate was then (correctly) rejected — so a
    // pasted `KEY=value` was detected only when its message happened to be the last leaf in the body.
    const trailing = { role: "assistant", content: "ok" };
    expect(await bodyCount([{ role: "user", content: `API_TOKEN=${password}` }])).toBe(1);
    expect(await bodyCount([{ role: "user", content: `API_TOKEN=${password}` }, trailing])).toBe(1);
    expect(await bodyCount([{ role: "user", content: credentialUrl }])).toBe(1);
    expect(await bodyCount([{ role: "user", content: credentialUrl }, trailing])).toBe(1);
  });

  it("does not read a dev-server path after a port as URL userinfo", () => {
    // `host:port/@scope/...` parsed as user `host`, password `port/`, host `scope/...`. Userinfo
    // cannot contain `/` (RFC 3986); Vite (`/@vite/client`, `/@fs/`) and scoped-package URLs hit this.
    const urls = [
      `http${schemeSeparator}localhost:3000/@vite/client`,
      `http${schemeSeparator}localhost:5173/@react-refresh`,
      `http${schemeSeparator}127.0.0.1:8080/@fs/Users/dev/app/src/main.ts`,
    ];
    for (const url of urls) expect(detectSecretShapes(`GET ${url} 200`)).toEqual([]);
  });

  it("applies the placeholder filter to the credential, not to a host or PEM body", () => {
    // A hostname like `db.yourcompany.test` or `db.example.com` is not a placeholder credential.
    for (const host of ["db.yourcompany.test", "db.example.com"]) {
      const url = `postgresql${schemeSeparator}deploy:s3cr3tP4ss99@${host}/app`;
      expect(detectSecretShapes(url).map((value) => value.name)).toContain("credential-url");
    }
    // A password that IS a placeholder is still skipped.
    expect(detectSecretShapes(`postgresql${schemeSeparator}deploy:changeme-now-99@db.internal.test/app`)).toEqual([]);

    // A PEM body is base64; "xxx" or "Your" inside it is noise, not a docs placeholder. Built from
    // pieces so the fixture never looks like a key to the detector on the way through a proxy.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const armor = (kind: string) => `-----${kind} PRIVATE KEY-----`;
    for (const marker of ["xxx", "Your", "Sample"]) {
      const lines = [alphabet, alphabet.slice(0, 20) + marker + alphabet.slice(20 + marker.length), alphabet];
      const pem = [armor("BEGIN"), ...lines, armor("END")].join("\n");
      expect(detectSecretShapes(pem).map((value) => value.name)).toContain("private-key");
    }
  });

  it("detects Google OAuth access tokens", () => {
    const token = `ya29.a0Af${"AbCd1234".repeat(12)}`;
    expect(detectSecretShapes(`access_token=${token}`)).toEqual([
      expect.objectContaining({ name: "google-oauth-token", value: token, confidence: "high" }),
    ]);
  });

  it("stays linear on long identifier and base64url runs", () => {
    // Unbounded key/scheme runs and a `\b`-anchored JWT start made detection quadratic on a single
    // large dotted-identifier or base64url blob (seconds per 100 KB); a tool result can carry one.
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let ident = "";
    let b64url = "";
    for (let i = 0; i < 100_000; i++) {
      ident += i % 7 === 0 ? "." : alphabet[(i * 31) % alphabet.length];
      b64url += i % 64 === 0 ? "-" : alphabet[(i * 17) % alphabet.length]!.toUpperCase();
    }
    const started = performance.now();
    expect(detectSecretShapes(ident)).toEqual([]);
    expect(detectSecretShapes(b64url)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
