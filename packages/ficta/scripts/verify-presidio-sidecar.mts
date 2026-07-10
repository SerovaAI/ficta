import assert from "node:assert/strict";
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

const text = `6th July 2026

LETTER OF INVITATION

Please accept this invitation for Alice Example - A12345678 and Candice Sample.
Alice and Candice will stay at 110A Plantation
Marguery, Tamarin, Black River from 25 June 2026 to 3rd of August 2026.
I can be reached on +230 5705 4725 or alice@example.com.

Kind regards,
Morgan Signer
X2024ABC123456`;

const expected = [
  { value: "Alice Example", category: "person" },
  { value: "Candice Sample", category: "person" },
  { value: "Alice", category: "person" },
  { value: "Candice", category: "person" },
  { value: "A12345678", category: "document-id" },
  { value: "X2024ABC123456", category: "document-id" },
  { value: "3rd of August 2026", category: "date-time" },
  { value: "+230 5705 4725", category: "phone-number" },
  { value: "alice@example.com", category: "email-address" },
  { value: "Plantation\nMarguery", category: "location" },
  { value: "Tamarin", category: "location" },
  { value: "Black River", category: "location" },
  { value: "25 June 2026", category: "date-time" },
  { value: "6th July 2026", category: "date-time" },
] as const;

const engine = new ProtectionEngine({ plugins: [piiPlugin] });
const body = JSON.stringify({ content: text });
const redacted = await engine.redactBodyDetailed(body, { traceValues: true });
const traceByValue = new Map((redacted.traceValues ?? []).map((value) => [value.value, value]));

for (const item of expected) {
  assert.equal(redacted.body.includes(item.value), false, "a required synthetic value survived redaction");
  assert.equal(traceByValue.get(item.value)?.name, item.category, "a synthetic value has the wrong category");
}
assert.equal(redacted.leaks, 0, "the known-value leak gate reported a survivor");
assert.equal(engine.restoreJson(redacted.body), body, "the synthetic document did not round-trip exactly");
for (const tokenType of ["PERSON", "ID", "DATE", "PHONE", "EMAIL", "LOCATION"]) {
  assert.match(redacted.body, new RegExp(`FICTA_${tokenType}_[0-9a-f]{32}`));
}

const categories = new Map<string, number>();
for (const value of redacted.traceValues ?? []) categories.set(value.name, (categories.get(value.name) ?? 0) + 1);
console.log(
  JSON.stringify(
    {
      sidecar: url,
      expectedValues: expected.length,
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
