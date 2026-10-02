---
"@serovaai/ficta-engine": minor
---

Engine: `restoreTextDetailed(text, { unknownToken })` on the engine and on scopes restores a complete text and returns `{ text, restoredCount, unknownCount }`. Every token-shaped string the vault does not map (unknown, model-mutated, truncated, wildcard entity references, or pruned/forgotten from a vault store) is counted and, with `unknownToken`, replaced by that placeholder; it is never mapped to a value. Destroy markers are not tokens. `restoreText` and the JSON/streaming restores are unchanged.
