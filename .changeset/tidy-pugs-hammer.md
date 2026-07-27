---
"@serovaai/ficta": patch
---

Stop redacting optional-chained and non-null-asserted property accesses. The code-reference rejections in the secret-shape detector matched only plain dotted identifier chains, and `?.` and `!` fall outside the identifier character class — so expressions like `config.auth?.accessToken` and `process.env.SERVICE_API_KEY!` read as opaque high-entropy values and were replaced with surrogates in source an agent was reading. Measured across 4,098 tracked files, this removes 14 such detections and adds none.
