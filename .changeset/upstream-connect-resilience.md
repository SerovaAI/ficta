---
"@serovaai/ficta": patch
---

Make upstream connections resilient on slow or VPN networks: the proxy now uses a dedicated HTTP client that gives each address family 2.5s to connect (instead of Node's 250–500ms happy-eyeballs cutoff, which abandoned slow IPv4 connects in favour of unreachable IPv6 routes and returned `502 … AggregateError [ETIMEDOUT]`), and retries once when a request fails before it is sent.
