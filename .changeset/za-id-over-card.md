---
"@serovaai/ficta-engine": minor
"@serovaai/ficta": minor
---

A valid, Luhn-passing South African ID number is now classified as an ID rather than a credit card, deterministically. The reference Presidio sidecar drops `CREDIT_CARD` when `ZA_ID_NUMBER` validated the same span; the PII plugin no longer lets backend result order pick a value's category and prefers a configured backend over the regex floor; and the engine adds `detection.entityPriority` (categories, highest first) for values reported under several categories. Destroying the ID category alone now destroys such an ID; it no longer needs `credit-card` destroyed too.
