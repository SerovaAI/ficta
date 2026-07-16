---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": minor
"@serovaai/ficta-gateway": minor
---

Per-chat jurisdiction-scoped PII detection. Each Gateway chat can enable additional detection
jurisdictions from its protection dropdown (persisted per thread); the setting additively widens
best-effort Presidio detection with jurisdiction entity bundles (e.g. `uk` enables
NHS/NINO/driving-licence/passport/postcode/vehicle-registration recognizers) via the new internal
`x-ficta-detection-profile` header, per request, with no proxy or sidecar restart. Every Presidio
`/analyze` request now sends an explicit entity allowlist — the default baseline when none is
configured — so the newly loaded UK recognizers are unreachable for default traffic and the
historical NHS-matches-ZA-account-numbers false positive stays fixed. Profiles are strictly
additive (never narrowing baseline coverage or affecting exact-match registered values), and a
keyed scope's swept-leaf cache is invalidated when its profile changes.
