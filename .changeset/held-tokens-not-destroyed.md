---
"@serovaai/ficta-engine": patch
---

A value a keyed scope already holds a token for keeps that token in a destroying profile instead of becoming a destroy marker. Previously a narrowed first pass under `destroy: { categories: "*" }` destroyed names a second pass had tokenised once a later run reopened the vault, so the same text got a token in one run and a marker in the next.
