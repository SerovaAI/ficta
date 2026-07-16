import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ProtectionEngine } from "../src/engine/engine.js";
import { DEFAULT_BASELINE_ENTITIES, JURISDICTION_ENTITY_BUNDLES } from "../src/engine/plugins/pii/jurisdictions.js";
import { piiPlugin } from "../src/plugins/index.js";

const url = (process.env.FICTA_PII_PRESIDIO_URL ?? "http://127.0.0.1:5002").replace(/\/+$/, "");
process.env.FICTA_PII_ENABLED = "1";
process.env.FICTA_PII_BACKENDS = "presidio";
process.env.FICTA_PII_PRESIDIO_URL = url;
process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS ??= "5000";
process.env.FICTA_SURROGATE_STYLE = "typed";

const health = await fetch(`${url}/health`);
assert.equal(health.ok, true, `Presidio sidecar is not healthy at ${url}`);

const negativeText =
  "lowercase a12345678; short A1234567; long A123456789; embedded XA12345678Z; short phone +230 1234";
const negativeResponse = await fetch(`${url}/analyze`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    text: negativeText,
    language: "en",
    score_threshold: 0.5,
    entities: ["DOCUMENT_ID", "PHONE_NUMBER"],
  }),
});
assert.equal(negativeResponse.ok, true, "Presidio rejected the negative-control request");
assert.deepEqual(await negativeResponse.json(), [], "a near-miss document ID or phone shape matched");

// --- Jurisdiction gating (UK recognizers are loaded but reachable only via a `uk` profile) -------

// Drift gate: the TS baseline + bundles and the sidecar's loaded recognizers must agree in BOTH
// directions. A recognizer the TS side doesn't know about would run unfiltered nowhere (fine) but
// signals YAML/TS divergence; a TS entity the sidecar doesn't load silently disables coverage.
const supportedResponse = await fetch(`${url}/supportedentities?language=en`);
assert.equal(supportedResponse.ok, true, "Presidio rejected /supportedentities");
const supported = new Set((await supportedResponse.json()) as string[]);
const declared = new Set([...DEFAULT_BASELINE_ENTITIES, ...Object.values(JURISDICTION_ENTITY_BUNDLES).flat()]);
const missingOnSidecar = [...declared].filter((entity) => !supported.has(entity));
const unknownToTs = [...supported].filter((entity) => !declared.has(entity));
assert.deepEqual(missingOnSidecar, [], `TS declares entities the sidecar does not load: ${missingOnSidecar}`);
assert.deepEqual(unknownToTs, [], `sidecar loads entities the TS baseline/bundles do not declare: ${unknownToTs}`);

// The historical false positive: a bare ZA account number passes the NHS mod-11 checksum. With the
// UK recognizer now LOADED, the baseline allowlist is the only thing keeping it out of default
// traffic — so prove a baseline request returns no UK_NHS span for an account-context number.
const zaAccountText = "Rekeningnommer: 9434765919";
const baselineSpans = (await analyze(zaAccountText, [...DEFAULT_BASELINE_ENTITIES])) as Array<{
  entity_type: string;
}>;
assert.equal(
  baselineSpans.some((span) => span.entity_type === "UK_NHS"),
  false,
  "UK_NHS matched a ZA account number under the baseline allowlist — the NHS false positive is back",
);

// And the flip side: the same checksum shape IS detected once a uk profile widens the allowlist.
const nhsText = "Patient NHS Number: 943 476 5919 per the disclosure bundle.";
const ukSpans = (await analyze(nhsText, [
  ...DEFAULT_BASELINE_ENTITIES,
  ...(JURISDICTION_ENTITY_BUNDLES.uk ?? []),
])) as Array<{ entity_type: string }>;
assert.equal(
  ukSpans.some((span) => span.entity_type === "UK_NHS"),
  true,
  "the NHS number was not detected even with the uk jurisdiction bundle",
);

async function analyze(text: string, entities: string[]): Promise<unknown> {
  const response = await fetch(`${url}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, language: "en", score_threshold: 0.5, entities }),
  });
  assert.equal(response.ok, true, `Presidio rejected an /analyze request (HTTP ${response.status})`);
  return response.json();
}

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

// Engine-level double run: identical NHS content is never categorized as uk-nhs for default
// traffic (a spaced 10-digit run may still redact as a baseline phone-number match — over-
// redaction under a wrong-but-harmless category, not a gating failure) and IS categorized as
// uk-nhs under a uk-profiled keyed scope — the whole seam, end to end.
const nhsBody = JSON.stringify({ content: "NHS Number: 943 476 5919" });
const defaultRun = await engine.beginRequest().redactBodyDetailed(nhsBody, { traceValues: true });
assert.equal(
  (defaultRun.traceValues ?? []).some((value) => value.name === "uk-nhs"),
  false,
  "default traffic categorized a value as uk-nhs — the jurisdiction gate is open",
);
const ukRun = await engine
  .beginRequest("verify:uk-matter", { detectionProfile: { jurisdictions: ["uk"] } })
  .redactBodyDetailed(nhsBody, { traceValues: true });
assert.equal(ukRun.body.includes("943 476 5919"), false, "the uk-profiled scope left the NHS number visible");
assert.equal(
  (ukRun.traceValues ?? []).some((value) => value.name === "uk-nhs"),
  true,
  "the uk-profiled scope did not categorize the NHS number as uk-nhs",
);

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
      jurisdictionGating: "uk gated: baseline clean, uk profile detects",
      entityDrift: "supportedentities == baseline ∪ bundles",
      categories: Object.fromEntries([...categories].sort(([a], [b]) => a.localeCompare(b))),
      roundTrip: "exact",
    },
    null,
    2,
  ),
);
