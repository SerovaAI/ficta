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
      categories: Object.fromEntries([...categories].sort(([a], [b]) => a.localeCompare(b))),
      roundTrip: "exact",
    },
    null,
    2,
  ),
);
