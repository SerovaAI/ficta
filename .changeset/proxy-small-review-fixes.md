---
"@serovaai/ficta": patch
---

Three local-proxy fixes from the October review. The proxy now strips hop-by-hop request headers (`Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding` and the rest of the RFC 9110 set, plus any header named in `Connection`) before the upstream hop; clients that sent one, such as a keep-alive header on a chunked body, got a 502. A refused WebSocket upgrade no longer writes the agent's launch token to the log. And `ficta <agent>` now prints a one-line stderr warning whenever dev trace is on, including when it was set in `config.toml`. Until now only `ficta doctor` mentioned it.
