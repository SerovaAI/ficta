---
"@serovaai/ficta-engine": minor
---

Destroy dispositions accept `categories: "*"` to destroy every detector finding whatever its category (registered and roster values keep their surrogates), so a keyed two-pass flow persists only roster mappings. A keyed scope now re-applies a roster short form it already holds at word boundaries and with its linked entity token (also after hydrating from the vault store), instead of a literal token inside longer words. `redactMany` reports roster matches (`hits[].roster`) and warns once that their tokens cannot be restored.
