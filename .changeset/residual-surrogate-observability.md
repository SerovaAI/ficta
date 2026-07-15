---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": patch
---

Observe residual surrogate tokens that survive restore. A surrogate-shaped token with no dictionary mapping — mutated, truncated, or invented by the model (e.g. a wildcard entity-family reference like `FICTA_ORG_<entityTag>_*`) — is now counted per response and surfaced as a values-free total in the proxy log (`⚠️ N unrestored surrogate token(s)`), `protection-stats.json`, and the stats summary. Detection covers opaque, typed, and entity-family token shapes plus entity-family prefix fragments, across buffered, streamed, and SSE restore paths. Observe-only: response bytes are unchanged, and restore remains exact-match — unknown tokens are never fuzzily recovered.
