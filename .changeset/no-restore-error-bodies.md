---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-engine": patch
---

Proxy: never rehydrate surrogates in a non-2xx response body. A provider error reflects request fields back (e.g. `model: FICTA_… not found`), so restoring error bodies let any caller who knew a placeholder recover its real value by sending a deliberately-malformed request — no provider auth needed. Error bodies now pass through with the placeholder intact; successful (2xx) round-trips, including on non-standard routes, are unchanged.
