# Threat model — Ficta Gateway PII handling

> Addendum to [`threat-model.md`](../../../packages/ficta/docs/threat-model.md), scoped to the sensitive-data chat gateway
> (`apps/gateway`). The base threat model still governs; this states **the gateway's promise in its own
> words** so its best-effort boundary is never borrowed from the CLI's stronger exact-match promise.

## Promise

For a firm running the gateway **inside its own perimeter**, ficta attempts to **reduce** the
personal information that reaches the model vendor by detecting PII in outgoing chat/document text,
replacing detected spans with local surrogates before the request leaves the firm's network, and
restoring the real values locally in the answer shown to the user.

This is **best-effort reduction, not elimination.** It is **not** a guarantee that PII never reaches
the model. Undetected PII is forwarded verbatim. Any claim the firm makes on top of this must carry
that scope.

## Trust boundary

- **Hide data from the LLM vendor only.** The operator's own authorized users are trusted with the
  submitted PII; the vendor is not. Redaction happens on the egress hop to the vendor; restore happens
  locally.
- **Self-hosted.** The gateway runs in the firm's environment; registered values and detected spans
  are replaced before the provider hop. The model vendor still receives the tokenized transcript and
  any content outside those spans. If the gateway is run as a third-party hosted service, this threat
  model does not hold — that operator sees plaintext before redaction.

### Optional second-opinion service

An operator may make a hosted judgement service (TypeSafe, model Jev) available as a pre-send second
opinion by setting a `TYPESAFE_API_KEY` on the gateway. A workspace admin then turns it on
under Admin settings, or the operator pins it with `FICTA_GATEWAY_SECOND_OPINION=on|off`. It is off
by default and cannot be enabled without the key. When on, it changes the trust boundary in one
specific way:

- **What is sent.** For each message under review, the gateway sends the message text line by line
  with **every protected span already replaced by its placeholder**, plus each **detected** span
  together with its line. Registered values are never sent: they are substituted before the request
  is built. User-selected values are substituted too. Only detector-found spans travel as text,
  because a placeholder cannot be judged from context.
- **What comes back.** An advisory label per detected span (credential, content hash, organisation,
  legal term, and so on) and a probability per line that it still names a party or states a
  commercial term. The gateway never changes what the proxy redacts on this basis; it marks lines
  for the user to look at and appends the label to the finding's tooltip. Selecting a value from a
  marked line goes through the same explicit path as any other user selection.
- **Failure posture.** Fail open. A timeout, error, missing key, or oversized message yields no
  second opinion and the review proceeds exactly as without the feature.
- **Vendor terms.** TypeSafe is a hosted API with no self-hosted option. Its published policy is
  not to train on customer data; zero data retention is an enterprise arrangement. Its data
  processing agreement names no fixed retention window, hosting region, or certification. Treat it
  as a subprocessor that receives detected spans and their surrounding lines, and confirm those
  terms fit the firm's obligations before enabling it.
- **Adversarial input.** The service does not treat message text as hostile; instructions embedded
  in a document could shift its answers. Because its output is advisory and a person confirms every
  selection, the failure mode is a missed hint, not a changed redaction.

## Two layers, two strengths

**Strong (inherited from the base threat model):** the firm's **registered values** — a loaded
client/matter roster, party names, matter IDs — get the base exact-match promise: replaced before
covered surfaces leave, and **fail-closed blocked** if one would be forwarded verbatim in a surface
ficta is supposed to redact.

**Best-effort (this document):** **detected PII** — the regex backend (email, US SSN, Luhn card) and
the Presidio sidecar (deterministic recognizers plus NER for names, locations, organizations, phones,
dates, and configured document-ID shapes). NER is probabilistic: it will miss entities, especially
unusual names, partial identifiers, and firm-specific shapes not registered or added as
recognizers/deny-lists. Detection is only as good as the configured backend.

In a trusted keyed Gateway chat, registered people and organizations use context-bound family tokens.
Explicit registered forms share one entity tag; a high-confidence detected organization alias joins
only when exactly one registered anchor matches. That link preserves detector provenance and trust.
Ambiguous and detector-only findings remain literal tokens, and people are never linked from an
inferred short name. The provider can see only the coarse person/organization type and that two tokens
belong to the same entity within this chat—not the identity, registry ID, matter, role, or a stable
cross-chat identifier.

**The shipped Presidio policy is identity and attribution, not general document confidentiality.**
Its custom recognizer applies context and entity-shape gates inside Presidio before candidates reach
Ficta. It protects structured identifiers and contact/account values, plus qualified people,
organizations and aliases, company registration numbers, birth dates, and personal addresses. It
suppresses common NER false positives such as legal roles, headings, courts, durations, ordinary
dates, jurisdictions, and nationality labels. Another Presidio-compatible deployment may implement
a different policy; Ficta does not claim these semantics for arbitrary analyzer URLs.

Amounts, rates, percentages, contract periods, project terms, and other commercial facts are not
automatically protected by the PII detector. Users must select them in pre-send review or admins
must register them when they are confidential. For exact confidentiality of a specific
client/counterparty/matter entity, register it so it receives the strong exact-match promise rather
than relying on probabilistic NER.

The shipped Presidio recognizer applies a conservative accounting-text supplement around NER: a
title-cased business name in a date-led transaction/payee column can be inferred from the table
structure, and a business-name variant can be inferred when it shares the full non-designator stem
with an organization already found in the same document. Generic NER name spans crossing
tab-separated fields, or containing no letters, are discarded. These rules reduce common statement
misses and table-header/amount false positives; they remain heuristics, do not learn across requests,
and do not turn organization detection into an exact guarantee.

**Explicit user selections:** Gateway's pre-send review lets a user mark a phrase the configured detectors
missed. That phrase receives exact-match, registry-strength treatment inside the user's current chat and is
re-applied on later sends from Gateway's private thread storage. This improves the request the user actually
reviewed; it does not make PII detection complete, infer other missed phrases, or silently promote the value to
organization-wide policy. Workspace promotion remains an admin-reviewed Protected Registry action. The optional
second-opinion service can point at a line worth checking, but the selection itself is still the user's.

## Fail-closed does not rescue missed PII

This is the load-bearing caveat and must not be blurred:

- Fail-closed (the leak backstop in the base model) guards **registered exact values only.** It
  cannot fail closed on PII it never detected — there is nothing to match against. Structurally,
  detection cannot be complete, and the backstop cannot cover for it.
- A separate, unrelated control — `FICTA_PII_FAIL_CLOSED` ↔ `[pii] fail_closed` — governs what
  happens when the **detector itself is unavailable** (Presidio down): skip detection for that request
  (default, warn-once) or block it (503). **For the gateway, run this as block (fail-closed):** a firm
  should not silently forward un-scanned text because a sidecar was down. This is about detector
  _availability_, not detection _completeness_ — even with it on, undetected PII still passes.

## Intentionally not covered

- **Undetected PII.** Anything the configured backend misses is forwarded verbatim.
- **PII outside the deployment's country scope.** Country-specific recognizers (e.g. UK NHS/NINO)
  load only when the sidecar's `FICTA_PRESIDIO_SUPPORTED_COUNTRIES` scope includes their country; a
  UK identifier on a deployment scoped to `za,us,mu` is undetected-by-design (its recognizer
  false-positives outside its home jurisdiction). Scope is load-time deployment configuration —
  there is no per-request widening, so no request content or header can change what is detected.
- **Numeric PII inside JSON.** Detection runs over the redactable string surface; a bare JSON number
  leaf (e.g. an un-quoted card number) is not a rewritable span and is neither tokenized nor treated
  as a leak. Register such values or ensure they arrive as strings.
- **Transformed values** — base64/URL-encoded/split/hashed PII, unless the transformed form is also
  registered.
- **Response-side PII the model itself emits.** The concern is egress; there is nothing local to
  restore for content the model generates. The vendor still authored it.
- **What the vendor legitimately sees:** the tokenized transcript, its structure, timing, and all
  non-PII text of the conversation. With the shipped Presidio recognizer this includes amounts, rates,
  durations, jurisdictions, ordinary dates, and unselected business terms. Redaction removes
  detected identifiers, not the prompt itself.
- **Document ingestion gaps.** PDF/DOC/DOCX are converted to text before detection; anything the
  converter drops or garbles (scanned images without OCR, complex tables) is detected imperfectly or
  not at all.
- Everything already out of scope in [`threat-model.md`](../../../packages/ficta/docs/threat-model.md) (auth headers,
  tool-channel egress, binary responses, IDE clients).

## Compliance framing

The gateway is a **data-minimization control the firm operates.** It can support the firm's own
POPIA/GDPR data-minimization posture by reducing personal information sent to a processor. It is
**not** DLP, **not** a compliance certification, and confers no compliance status on its own. The firm
remains the responsible party for its obligations.

## Public-claim guardrails

- Describe registered-value exact matching separately from best-effort PII detection.
- Say **reduction**, never **elimination** or "PII never reaches the model."
- State the self-hosted assumption whenever describing the trust boundary.
- Do not apply the CLI's exact-match, fail-closed language to detected PII.

## See also

- [`threat-model.md`](../../../packages/ficta/docs/threat-model.md) — the base promise and non-goals this addendum extends.
