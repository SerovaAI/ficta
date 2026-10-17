---
"@serovaai/ficta": patch
---

Proxy now talks HTTP/1.1 to upstream providers instead of negotiating HTTP/2, avoiding intermittent `502 … NGHTTP2_INTERNAL_ERROR` failures when a provider resets an h2 stream.
