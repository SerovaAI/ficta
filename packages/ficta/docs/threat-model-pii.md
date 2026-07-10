# Threat model — PII chat gateway (Product B)

> Addendum to [`threat-model.md`](./threat-model.md), scoped to the sensitive-data chat gateway
> (`apps/gateway`). The base threat model still governs; this states **the gateway's promise in its own
> words** so its best-effort boundary is never borrowed from the CLI's stronger exact-match promise.

## The promise (say exactly this)

For a firm running the gateway **inside its own perimeter**, ficta attempts to **reduce** the
personal information that reaches the model vendor by detecting PII in outgoing chat/document text,
replacing detected spans with local surrogates before the request leaves the firm's network, and
restoring the real values locally in the answer shown to the user.

This is **best-effort reduction, not elimination.** It is **not** a guarantee that PII never reaches
the model. Undetected PII is forwarded verbatim. Any claim the firm makes on top of this must carry
that scope.

## Trust boundary

- **Hide data from the LLM vendor only.** The firm's own users (lawyers) are trusted with client PII;
  the vendor is not. Redaction happens on the egress hop to the vendor; restore happens locally.
- **Self-hosted.** The gateway runs in the firm's environment; registered values and detected spans
  are replaced before the provider hop. The model vendor still receives the tokenized transcript and
  any content outside those spans. If the gateway is run as a third-party hosted service, this threat
  model does not hold — that operator sees plaintext before redaction.

## Two layers, two strengths

**Strong (inherited from the base threat model):** the firm's **registered values** — a loaded
client/matter roster, party names, matter IDs — get the base exact-match promise: replaced before
covered surfaces leave, and **fail-closed blocked** if one would be forwarded verbatim in a surface
ficta is supposed to redact. This is the layer to lead the demo with.

**Best-effort (this document):** **detected PII** — the regex backend (email, US SSN, Luhn card) and
the Presidio sidecar (deterministic recognizers plus NER for names, locations, organizations, phones,
dates, and configured document-ID shapes). NER is probabilistic: it will miss entities, especially
unusual names, partial identifiers, and firm-specific shapes not registered or added as
recognizers/deny-lists. Detection is only as good as the configured backend.

**Organization detection is enabled but noisy.** `ORGANIZATION` NER is un-suppressed via
`presidio/nlp_engine.za.yaml` (upstream ignores it — "Has many false positives"), so unregistered
client/counterparty/company names get a best-effort catch from spaCy `en_core_web_lg`. Expect
**over-redaction** (headings, common capitalized nouns tokenized as orgs) — the safe failure for a
privacy tool, but a usability cost. For higher precision, layer a HuggingFace ORG recognizer in
`presidio/default_recognizers.za.yaml` (real per-span confidence). For exact confidentiality of
specific client/counterparty/matter entities, register them in the value registry so they get the
strong exact-match promise rather than relying on probabilistic NER.

**Explicit user selections:** Gateway's pre-send review lets a user mark a phrase the configured detectors
missed. That phrase receives exact-match, registry-strength treatment inside the user's current chat and is
re-applied on later sends from Gateway's private thread storage. This improves the request the user actually
reviewed; it does not make PII detection complete, infer other missed phrases, or silently promote the value to
organization-wide policy. Workspace promotion remains an admin-reviewed Protected Registry action.

## Fail-closed does not rescue missed PII

This is the load-bearing caveat and must not be blurred:

- Fail-closed (the leak backstop in the base model) guards **registered exact values only.** It
  cannot fail closed on PII it never detected — there is nothing to match against. Structurally,
  detection cannot be complete, and the backstop cannot cover for it.
- A separate, unrelated control — `FICTA_PII_FAIL_CLOSED` ↔ `[pii] fail_closed` — governs what
  happens when the **detector itself is unavailable** (Presidio down): skip detection for that request
  (default, warn-once) or block it (503). **For the gateway, run this as block (fail-closed):** a firm
  should not silently forward un-scanned text because a sidecar was down. This is about detector
  *availability*, not detection *completeness* — even with it on, undetected PII still passes.

## Intentionally not covered

- **Undetected PII.** Anything the configured backend misses is forwarded verbatim.
- **Numeric PII inside JSON.** Detection runs over the redactable string surface; a bare JSON number
  leaf (e.g. an un-quoted card number) is not a rewritable span and is neither tokenized nor treated
  as a leak. Register such values or ensure they arrive as strings.
- **Transformed values** — base64/URL-encoded/split/hashed PII, unless the transformed form is also
  registered.
- **Response-side PII the model itself emits.** The concern is egress; there is nothing local to
  restore for content the model generates. The vendor still authored it.
- **What the vendor legitimately sees:** the tokenized transcript, its structure, timing, and all
  non-PII text of the conversation. Redaction removes detected identifiers, not the prompt itself.
- **Document ingestion gaps.** PDF/DOC/DOCX are converted to text before detection; anything the
  converter drops or garbles (scanned images without OCR, complex tables) is detected imperfectly or
  not at all.
- Everything already out of scope in [`threat-model.md`](./threat-model.md) (auth headers,
  tool-channel egress, binary responses, IDE clients).

## Compliance framing

The gateway is a **data-minimization control the firm operates.** It can support the firm's own
POPIA/GDPR data-minimization posture by reducing personal information sent to a processor. It is
**not** DLP, **not** a compliance certification, and confers no compliance status on its own. The firm
remains the responsible party for its obligations.

## Positioning guardrails

- Lead with the strong layer (registered client roster), not the best-effort PII layer.
- Say **reduction**, never **elimination** / "PII never reaches the model" / "secure".
- State the self-hosted assumption whenever the trust argument is made.
- Do not let the CLI's exact-match, fail-closed language attach to detected PII.

## See also

- [`threat-model.md`](./threat-model.md) — the base promise and non-goals this addendum extends.
