import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEngineWarnSink } from "../src/engine/diagnostics.js";
import { ProtectionEngine } from "../src/engine/engine.js";
import { regexRecognizer } from "../src/engine/plugins/pii/regex-recognizer.js";
import { DetectorUnavailableError } from "../src/engine/redaction-engine.js";
import {
  activeBackend,
  activeBackends,
  type ProtectedValue,
  piiPlugin,
  resetPiiRecognizerStateForTests,
  resolveAgentPiiEnabled,
  selectedBackendName,
  selectedBackendNames,
} from "../src/plugins/index.js";

const EMAIL = "alice@example.com";
const SSN = "123-45-6789";
const VISA = "4111 1111 1111 1111"; // Luhn-valid test card number
const NOT_A_CARD = "1234 5678 9012 3456"; // 16 digits, fails Luhn

describe("pii regex recognizer", () => {
  it("detects email, US SSN, and Luhn-valid card numbers", () => {
    const found = regexRecognizer.detect(`contact ${EMAIL}, ssn ${SSN}, card ${VISA}`, {
      surface: "body",
    }) as ProtectedValue[];
    const byCategory = Object.fromEntries(found.map((v) => [v.name, v.value]));

    expect(byCategory.email).toBe(EMAIL);
    expect(byCategory["us-ssn"]).toBe(SSN);
    expect(byCategory["credit-card"]).toBe(VISA);
    for (const value of found) expect(value.kind).toBe("pii");
  });

  it("rejects digit runs that fail the Luhn check", () => {
    const found = regexRecognizer.detect(`card ${NOT_A_CARD}`, { surface: "body" }) as ProtectedValue[];
    expect(found.some((v) => v.name === "credit-card")).toBe(false);
  });

  it("does not absorb a trailing separator into the card value", () => {
    const found = regexRecognizer.detect(`card ${VISA} expires soon`, { surface: "body" }) as ProtectedValue[];
    // The match must end on the last digit — no trailing space pulled in (would mangle vendor text).
    expect(found.find((v) => v.name === "credit-card")?.value).toBe(VISA);
  });

  it("attaches UTF-16 offsets and merges repeated matches of the same value", () => {
    const text = `first ${EMAIL}; second ${EMAIL}`;
    const found = regexRecognizer.detect(text, { surface: "body" }) as ProtectedValue[];
    const email = found.find((value) => value.value === EMAIL);
    const first = text.indexOf(EMAIL);
    const second = text.lastIndexOf(EMAIL);
    expect(email?.spans).toEqual([
      { start: first, end: first + EMAIL.length },
      { start: second, end: second + EMAIL.length },
    ]);
  });
});

describe("pii detector plugin", () => {
  const ENV = "FICTA_PII_ENABLED";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("is disabled by default (no detections)", async () => {
    delete process.env[ENV];
    expect(await piiPlugin.detectText?.(`email ${EMAIL}`, { surface: "body" })).toEqual([]);
  });

  it("detects and round-trips PII through the engine when enabled", async () => {
    process.env[ENV] = "1";
    const engine = new ProtectionEngine({ plugins: [piiPlugin] });
    const body = JSON.stringify({ content: `email ${EMAIL}` });

    const redacted = await engine.redactBodyDetailed(body);
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(EMAIL);
    expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted.body)).toContain(EMAIL);
  });

  it("counts distinct values restored back into a request's response", async () => {
    process.env[ENV] = "1";
    const engine = new ProtectionEngine({ plugins: [piiPlugin] });
    const scope = engine.beginRequest();
    const body = JSON.stringify({ content: `emails ${EMAIL} and ${SSN}` });

    const redacted = await scope.redactBodyDetailed(body);
    expect(redacted.count).toBe(2);
    expect(scope.restoredCount).toBe(0); // nothing restored yet — only egress redaction happened

    // Simulate the response echoing both surrogates back; restore should tally each distinct value.
    scope.restoreJson(redacted.body);
    expect(scope.restoredCount).toBe(2);

    // Restoring the same surrogates again does not double-count (Set of raw values).
    scope.restoreText(redacted.body);
    expect(scope.restoredCount).toBe(2);
  });

  it("reports `protecting` only when actually active, not merely present", () => {
    delete process.env[ENV];
    const off = new ProtectionEngine({ plugins: [piiPlugin] });
    expect(off.enabled).toBe(true); // detector is present
    expect(off.protecting).toBe(false); // ...but disabled → pure passthrough, banner must not claim redaction

    process.env[ENV] = "1";
    const on = new ProtectionEngine({ plugins: [piiPlugin] });
    expect(on.protecting).toBe(true);
  });

  it("declares a config binding and reports its status via discover()", () => {
    expect(piiPlugin.config?.bindings.map((b) => b.env)).toContain(ENV);
    expect(piiPlugin.config?.bindings.map((b) => b.env)).toContain("FICTA_PII_AGENTS");

    process.env[ENV] = "0";
    expect(piiPlugin.discover?.()[0]?.status).toBe("disabled");
    process.env[ENV] = "1";
    // On detector reports `active` (matches per request) with no value count, not `available`/(0 values).
    const active = piiPlugin.discover?.()[0];
    expect(active?.status).toBe("active");
    expect(active?.valueCount).toBeUndefined();
  });
});

describe("resolveAgentPiiEnabled (per-surface agent gate)", () => {
  it("is off by default (no config)", () => {
    expect(resolveAgentPiiEnabled({})).toBe(false);
  });

  it("stays off when only [pii] enabled is set — agents must opt in too", () => {
    expect(resolveAgentPiiEnabled({ enabled: "1" })).toBe(false);
    expect(resolveAgentPiiEnabled({ enabled: "1", agents: "0" })).toBe(false);
  });

  it("is a no-op when only [pii] agents is set — enabled is the kill switch", () => {
    expect(resolveAgentPiiEnabled({ agents: "1" })).toBe(false);
    expect(resolveAgentPiiEnabled({ enabled: "0", agents: "1" })).toBe(false);
  });

  it("turns on only when both [pii] enabled and [pii] agents are true", () => {
    expect(resolveAgentPiiEnabled({ enabled: "1", agents: "1" })).toBe(true);
  });

  it("lets an explicit shell FICTA_PII_ENABLED win in both directions", () => {
    // Shell "1" forces on even without the agents opt-in (single-run escape hatch)…
    expect(resolveAgentPiiEnabled({ shellValue: "1", enabled: "1", agents: "0" })).toBe(true);
    expect(resolveAgentPiiEnabled({ shellValue: "1" })).toBe(true);
    // …and shell "0" forces off even when config would enable it.
    expect(resolveAgentPiiEnabled({ shellValue: "0", enabled: "1", agents: "1" })).toBe(false);
  });

  it("falls through to config when the shell value is unparseable", () => {
    expect(resolveAgentPiiEnabled({ shellValue: "maybe", enabled: "1", agents: "1" })).toBe(true);
    expect(resolveAgentPiiEnabled({ shellValue: "maybe", enabled: "1", agents: "0" })).toBe(false);
  });
});

describe("pii backend selection", () => {
  const BACKEND_ENVS = [
    "FICTA_PII_ENABLED",
    "FICTA_PII_BACKEND",
    "FICTA_PII_BACKENDS",
    "FICTA_PII_FAIL_CLOSED",
    "FICTA_FAIL_CLOSED_DETECTION",
    "FICTA_PII_PRESIDIO_URL",
    "FICTA_PII_PRESIDIO_TIMEOUT_MS",
    "FICTA_PII_OPENMED_URL",
    "FICTA_PII_OPENMED_TIMEOUT_MS",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of BACKEND_ENVS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetPiiRecognizerStateForTests();
  });
  afterEach(() => {
    for (const key of BACKEND_ENVS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetPiiRecognizerStateForTests();
    vi.restoreAllMocks();
  });

  it("defaults to the regex backend and never reaches for a sidecar", () => {
    expect(selectedBackendName()).toBe("regex");
    expect(selectedBackendNames()).toEqual(["regex"]);
    const selection = activeBackend();
    expect(selection.name).toBe("regex");
    expect(selection.backend).toBe(regexRecognizer);
    expect(selection.unknown).toBeUndefined();
    expect(activeBackends().backends.map((backend) => backend.name)).toEqual(["regex"]);
  });

  it("keeps the legacy single backend selection behavior", async () => {
    const person = "Jonathan Q Appleseed";
    const { server, port } = await start((text) => {
      const idx = text.indexOf(person);
      return idx < 0 ? [] : [{ entity_type: "PERSON", start: idx, end: idx + person.length, score: 0.9 }];
    });
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;

    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const body = JSON.stringify({ content: `email ${EMAIL} for ${person}` });
      const redacted = await engine.redactBodyDetailed(body);

      // Exclusive: presidio caught the name; regex did NOT run, so the email is left untouched.
      expect(redacted.count).toBe(1);
      expect(redacted.body).not.toContain(person);
      expect(redacted.body).toContain(EMAIL);
      expect(engine.restoreText(redacted.body)).toContain(person);
    } finally {
      await close(server);
    }
  });

  it("runs each selected backend and merges their detections", async () => {
    const person = "Jonathan Q Appleseed";
    const { server, port } = await start((text) => {
      const idx = text.indexOf(person);
      return idx < 0 ? [] : [{ entity_type: "PERSON", start: idx, end: idx + person.length, score: 0.9 }];
    });
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKENDS = "presidio,regex";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;

    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const body = JSON.stringify({ content: `email ${EMAIL} for ${person}` });
      const redacted = await engine.redactBodyDetailed(body);

      expect(redacted.count).toBe(2);
      expect(redacted.body).not.toContain(person);
      expect(redacted.body).not.toContain(EMAIL);
      expect(engine.restoreText(redacted.body)).toContain(person);
      expect(engine.restoreText(redacted.body)).toContain(EMAIL);
    } finally {
      await close(server);
    }
  });

  it("fails open by skipping only the unavailable backend while reachable backends still run", async () => {
    // The unavailable-backend warning goes through the engine warn sink (which ficta wires to pino).
    // Install a capturing sink — a bare-library engine has a no-op sink by default.
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
    setEngineWarnSink((fields, message) => warnings.push({ fields, message }));
    const port = await closedPort(); // nothing listening → unreachable
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKENDS = "presidio,regex";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;

    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const body = JSON.stringify({ content: `email ${EMAIL}` });

      const first = await engine.redactBodyDetailed(body);
      const second = await engine.redactBodyDetailed(body);

      // Multi-backend + fail-open: the unavailable backend is skipped, but regex still runs.
      expect(first.count).toBe(1);
      expect(second.count).toBe(1);
      const backendWarnings = warnings.filter((w) => w.fields.backend === "presidio");
      expect(backendWarnings).toHaveLength(1); // throttled: repeats within the re-warn interval warn once
    } finally {
      setEngineWarnSink(() => {});
    }
  });

  it("re-warns once the interval elapses, with the running failure count, while the backend stays down", async () => {
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
    setEngineWarnSink((fields, message) => warnings.push({ fields, message }));
    // Drive the wall clock the re-warn throttle reads (the plugin uses Date.now, not a timer), so we
    // avoid faking timers and interfering with the fetch/abort path to the closed port.
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const port = await closedPort(); // nothing listening → unreachable
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;

    try {
      const engine = new ProtectionEngine({ plugins: [piiPlugin] });
      const body = JSON.stringify({ content: `email ${EMAIL}` });

      await engine.redactBodyDetailed(body); // first failure → warns
      await engine.redactBodyDetailed(body); // same instant → throttled
      now += 5 * 60 * 1000 + 1; // past the 5-minute re-warn interval
      await engine.redactBodyDetailed(body); // still down → re-warns

      const backendWarnings = warnings.filter((w) => w.fields.backend === "presidio");
      expect(backendWarnings).toHaveLength(2);
      expect(backendWarnings[0]?.message).toContain("unavailable —");
      expect(backendWarnings[0]?.message).not.toContain("still unavailable");
      // The re-warn reports the ongoing condition and the running failure count (3 attempts so far).
      expect(backendWarnings[1]?.message).toContain("still unavailable");
      expect(backendWarnings[1]?.fields.count).toBe(3);
    } finally {
      nowSpy.mockRestore();
      setEngineWarnSink(() => {});
    }
  });

  // Core resolves the fail-closed decision as `[pii] fail_closed override ?? FICTA_FAIL_CLOSED_DETECTION`.
  it("resolves fail-open/closed policy from per-plugin override then global default", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true); // silence the backend-down warning
    const port = await closedPort(); // nothing listening → the presidio backend is down
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ content: `email ${EMAIL}` });
    const run = () => new ProtectionEngine({ plugins: [piiPlugin] }).redactBodyDetailed(body);

    // global off + no per-plugin override → fail-open (skip, no throw).
    const openDefault = await run();
    expect(openDefault.count).toBe(0);

    // per-plugin override on → block, regardless of the global default.
    process.env.FICTA_PII_FAIL_CLOSED = "1";
    await expect(run()).rejects.toBeInstanceOf(DetectorUnavailableError);

    // global on + no per-plugin override → block.
    delete process.env.FICTA_PII_FAIL_CLOSED;
    process.env.FICTA_FAIL_CLOSED_DETECTION = "1";
    await expect(run()).rejects.toBeInstanceOf(DetectorUnavailableError);

    // per-plugin override off beats global on → fail-open (skip).
    process.env.FICTA_PII_FAIL_CLOSED = "0";
    const overrideOpen = await run();
    expect(overrideOpen.count).toBe(0);
  });

  it("falls back to regex for an unknown backend name and surfaces it in discover()", () => {
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "bogus";
    const selection = activeBackend();
    expect(selection.name).toBe("regex");
    expect(selection.unknown).toBe("bogus");

    const details = piiPlugin.discover?.()[0]?.details ?? [];
    expect(details.some((line) => line.includes("bogus"))).toBe(true);
  });

  it("skips unknown names in a multi-backend list while keeping known backends", () => {
    process.env.FICTA_PII_BACKENDS = "bogus,regex,presidio,openmed";
    const selection = activeBackends();
    expect(selection.backends.map((backend) => backend.name)).toEqual(["regex", "presidio", "openmed"]);
    expect(selection.unknown).toEqual(["bogus"]);
  });

  it("prefers the openmed detection when it duplicates another backend's value at equal confidence", async () => {
    const person = "Jonathan Q Appleseed";
    // Presidio-shaped stub: span array with a generic PERSON label.
    const presidio = await start((text) => {
      const idx = text.indexOf(person);
      return idx < 0 ? [] : [{ entity_type: "PERSON", start: idx, end: idx + person.length, score: 0.6 }];
    });
    // OpenMed-shaped stub: same value, same confidence tier, clinical label.
    const openmed = await startOpenmed((text) =>
      text.includes(person) ? [{ text: person, label: "PATIENT", confidence: 0.6 }] : [],
    );
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKENDS = "presidio,openmed";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${presidio.port}`;
    process.env.FICTA_PII_OPENMED_URL = `http://127.0.0.1:${openmed.port}`;

    try {
      const values = (await piiPlugin.detectText?.(`for ${person}`, { surface: "body" })) ?? [];
      expect(values).toHaveLength(1);
      expect(values[0]).toMatchObject({ value: person, source: "pii-openmed", name: "patient" });
    } finally {
      await close(presidio.server);
      await close(openmed.server);
    }
  });

  it("declares config bindings for backend selection and the sidecar backends", () => {
    const envs = piiPlugin.config?.bindings.map((b) => b.env) ?? [];
    expect(envs).toContain("FICTA_PII_BACKEND");
    expect(envs).toContain("FICTA_PII_BACKENDS");
    expect(envs).toContain("FICTA_PII_PRESIDIO_URL");
    expect(envs).toContain("FICTA_PII_PRESIDIO_SCORE_THRESHOLD");
    expect(envs).toContain("FICTA_PII_OPENMED_URL");
    expect(envs).toContain("FICTA_PII_OPENMED_MODEL");
    expect(envs).toContain("FICTA_PII_OPENMED_SCORE_THRESHOLD");
  });
});

type AnalyzeHandler = (text: string) => unknown;

/** OpenMed-shaped stub: wraps the handler's entities in the /pii/extract response envelope. */
async function startOpenmed(extract: AnalyzeHandler): Promise<{ server: Server; port: number }> {
  return start((text) => ({ entities: extract(text) }));
}

async function start(analyze: AnalyzeHandler): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const text = (JSON.parse(body) as { text: string }).text;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(analyze(text)));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { server, port };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closedPort(): Promise<number> {
  const { server, port } = await start(() => []);
  await close(server);
  return port;
}
