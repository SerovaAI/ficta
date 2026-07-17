import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ProtectionEngine } from "../src/engine/engine.js";
import { piiPlugin } from "../src/plugins/index.js";

const url = (process.env.FICTA_PII_PRESIDIO_URL ?? "http://127.0.0.1:5002").replace(/\/+$/, "");
process.env.FICTA_PII_ENABLED = "1";
process.env.FICTA_PII_BACKENDS = "presidio";
process.env.FICTA_PII_PRESIDIO_URL = url;
process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS ??= "5000";
process.env.FICTA_SURROGATE_STYLE = "typed";
const timeoutMs = Number(process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS);

/**
 * The entity surface of `presidio/default_recognizers.yaml` under the shipped
 * `supported_countries` reference profile (za, us, mu), plus the identity recognizer's NER
 * entities (registered in code, immune to the country filter). This list is the hand-reviewed
 * statement of the deployment contract: update it deliberately when the reference profile or the
 * registry changes, and this script will fail on any drift in either direction.
 */
const EXPECTED_SUPPORTED_ENTITIES = [
  // Locale-agnostic structured recognizers
  "CREDIT_CARD",
  "CRYPTO",
  "EMAIL_ADDRESS",
  "IBAN_CODE",
  "IP_ADDRESS",
  "MAC_ADDRESS",
  "PHONE_NUMBER",
  "URL",
  // Ficta custom recognizers (DOCUMENT_ID/ACCOUNT_NUMBER are deliberately locale-agnostic)
  "DOCUMENT_ID",
  "ACCOUNT_NUMBER",
  // Country-tagged recognizers loaded by the reference profile (za, us; mu shares PHONE_NUMBER)
  "ZA_ID_NUMBER",
  "US_BANK_NUMBER",
  "US_DRIVER_LICENSE",
  "US_ITIN",
  "US_PASSPORT",
  "US_SSN",
  "MEDICAL_LICENSE",
  // FictaSpacyIdentityRecognizer / FictaGlinerIdentityRecognizer NER entities
  "PERSON",
  "ORGANIZATION",
  "DATE_TIME",
  "LOCATION",
  "COMPANY_REGISTRATION",
];

// Same deadline discipline as the engine's sidecar client: every direct call aborts at the
// configured timeout instead of hanging the verification run.
async function fetchWithDeadline(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface Span {
  entity_type: string;
  start: number;
  end: number;
}

async function analyze(text: string, entities?: string[]): Promise<Span[]> {
  const payload: Record<string, unknown> = { text, language: "en", score_threshold: 0.5 };
  if (entities) payload.entities = entities;
  const response = await fetchWithDeadline(`${url}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.ok, true, `Presidio rejected an /analyze request (HTTP ${response.status})`);
  return (await response.json()) as Span[];
}

const health = await fetchWithDeadline(`${url}/health`);
assert.equal(health.ok, true, `Presidio sidecar is not healthy at ${url}`);

// Negative controls run without an `entities` field — the default request shape. Near-miss
// document-ID and phone shapes must not match even with every loaded recognizer running.
const negativeText =
  "lowercase a12345678; short A1234567; long A123456789; embedded XA12345678Z; short phone +230 1234";
const negativeSpans = await analyze(negativeText);
for (const entity of ["DOCUMENT_ID", "PHONE_NUMBER"]) {
  assert.equal(
    negativeSpans.some((span) => span.entity_type === entity),
    false,
    `a near-miss shape matched ${entity} in the negative controls`,
  );
}

// --- Country scoping (supported_countries in default_recognizers.yaml is the only gate) ---------

// Drift gate: the sidecar's loaded entity surface must equal this script's reference-profile
// contract in BOTH directions. An entity loaded but undeclared means the registry widened without
// review; a declared entity the sidecar doesn't load means coverage silently vanished.
const supportedResponse = await fetchWithDeadline(`${url}/supportedentities?language=en`);
assert.equal(supportedResponse.ok, true, "Presidio rejected /supportedentities");
const supported = new Set((await supportedResponse.json()) as string[]);
const declared = new Set(EXPECTED_SUPPORTED_ENTITIES);
const missingOnSidecar = [...declared].filter((entity) => !supported.has(entity));
const unexpectedOnSidecar = [...supported].filter((entity) => !declared.has(entity));
assert.deepEqual(
  missingOnSidecar,
  [],
  `reference profile declares entities the sidecar does not load: ${missingOnSidecar}`,
);
assert.deepEqual(
  unexpectedOnSidecar,
  [],
  `sidecar loads entities outside the reference profile: ${unexpectedOnSidecar}`,
);

// The country gate is load-time: out-of-scope recognizers must be UNLOADED, not merely
// allowlist-hidden. No UK entity may appear in the supported surface at all.
const ukLoaded = [...supported].filter((entity) => entity.startsWith("UK_"));
assert.deepEqual(ukLoaded, [], `UK recognizers are loaded despite the country scope: ${ukLoaded}`);

// Name-level check via /recognizers: the mu-tagged custom recognizer must survive the filter
// (its PHONE_NUMBER entity alone can't prove that — the stock locale-agnostic PhoneRecognizer
// also emits it) and no UK recognizer may be loaded under any name.
const recognizersResponse = await fetchWithDeadline(`${url}/recognizers?language=en`);
assert.equal(recognizersResponse.ok, true, "Presidio rejected /recognizers");
const recognizerNames = (await recognizersResponse.json()) as string[];
assert.equal(
  recognizerNames.includes("FictaMauritiusPhoneRecognizer"),
  true,
  "the mu-tagged FictaMauritiusPhoneRecognizer was filtered out — custom country_code tagging is broken",
);
const ukRecognizers = recognizerNames.filter((name) => name.startsWith("Uk") || name === "NhsRecognizer");
assert.deepEqual(ukRecognizers, [], `UK recognizers loaded despite the country scope: ${ukRecognizers}`);

// An unfiltered request (no `entities`) cannot reach out-of-scope recognizers. A spaced 10-digit
// run may still match PHONE_NUMBER — over-redaction under a wrong-but-harmless category is fine;
// a UK_NHS span means the load-time gate is open.
const nhsSpans = await analyze("Patient NHS Number: 943 476 5919 per the disclosure bundle.");
assert.equal(
  nhsSpans.some((span) => span.entity_type === "UK_NHS"),
  false,
  "UK_NHS matched on default traffic — supported_countries is not filtering",
);

// In-scope country-tagged recognizers survive the filter: the custom mu-tagged Mauritius phone
// recognizer and the predefined za recognizer must both fire on an unfiltered request.
const mauritiusSpans = await analyze("Please call +230 5251 2345 to confirm.");
assert.equal(
  mauritiusSpans.some((span) => span.entity_type === "PHONE_NUMBER"),
  true,
  "the mu-tagged Mauritius phone recognizer did not fire — country_code tagging on custom recognizers may be broken",
);
const zaIdSpans = await analyze("Identity number 8001015009087 appears on the affidavit.");
assert.equal(
  zaIdSpans.some((span) => span.entity_type === "ZA_ID_NUMBER"),
  true,
  "ZA_ID_NUMBER did not fire on an unfiltered request",
);

// Omitting `entities` must be behaviorally identical to requesting the full reference profile —
// the successor to the old "allowlist always sent" invariant, proving the default payload shape
// covers exactly the deployment's intended surface.
const equivalenceText = "Piet Botha (piet.botha@example.co.za) settled account number 9434765919 on 12 March 2026.";
const spanKey = (span: Span) => `${span.entity_type}:${span.start}:${span.end}`;
const omittedSpans = (await analyze(equivalenceText)).map(spanKey).sort();
const explicitSpans = (await analyze(equivalenceText, [...EXPECTED_SUPPORTED_ENTITIES])).map(spanKey).sort();
assert.deepEqual(
  omittedSpans,
  explicitSpans,
  "an /analyze without `entities` differs from the explicit reference-profile allowlist",
);

interface Fixture {
  name: string;
  text: string;
  expected: Array<{ value: string; entity: string }>;
  mustRemainVisible: string[];
}

const corpus = JSON.parse(
  await readFile(new URL("../bench/fixtures/pii-legal-identity.json", import.meta.url), "utf8"),
) as Fixture[];
const fixture = corpus.find(({ name }) => name === "synthetic-legal-loan");
assert.ok(fixture, "synthetic legal-loan fixture is missing");
const text = fixture.text;

const engine = new ProtectionEngine({ plugins: [piiPlugin] });
const body = JSON.stringify({ content: text });
const redacted = await engine.redactBodyDetailed(body, { traceValues: true });

for (const item of fixture.expected) {
  assert.equal(
    redacted.body.includes(item.value),
    false,
    `required synthetic identity survived redaction: ${item.entity} ${JSON.stringify(item.value)}`,
  );
}
for (const value of fixture.mustRemainVisible) {
  assert.equal(redacted.body.includes(value), true, `contract mechanic was over-redacted: ${value}`);
}
assert.equal(redacted.leaks, 0, "the known-value leak gate reported a survivor");
assert.equal(engine.restoreJson(redacted.body), body, "the synthetic document did not round-trip exactly");
for (const tokenType of ["PERSON", "ORG", "PII", "EMAIL"]) {
  assert.match(redacted.body, new RegExp(`FICTA_${tokenType}_[0-9a-f]{32}`));
}

const categories = new Map<string, number>();
for (const value of redacted.traceValues ?? []) categories.set(value.name, (categories.get(value.name) ?? 0) + 1);
console.log(
  JSON.stringify(
    {
      sidecar: url,
      expectedValues: fixture.expected.length,
      redactedDistinct: redacted.count,
      knownSurvivors: redacted.leaks,
      negativeControls: "clean",
      countryScoping: "uk unloaded; za/us/mu loaded",
      entityDrift: "supportedentities == reference profile",
      categories: Object.fromEntries([...categories].sort(([a], [b]) => a.localeCompare(b))),
      roundTrip: "exact",
    },
    null,
    2,
  ),
);
