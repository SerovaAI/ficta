---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": minor
"@serovaai/ficta-gateway": minor
---

Per-chat jurisdiction-scoped PII detection. Each Gateway chat can enable additional detection
jurisdictions from its protection dropdown, persisted per chat. Enabling a jurisdiction additively
widens best-effort PII detection with that jurisdiction's identifier coverage (e.g. `uk` adds NHS
number, National Insurance number, driving licence, passport, postcode, and vehicle registration
detection), effective immediately for that chat. Jurisdictions only ever add protection — they
never narrow default detection coverage or affect exact-match protection of registered values.
