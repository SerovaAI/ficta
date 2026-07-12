---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
---

Document routing `ficta claude` through a local Anthropic-compatible proxy via `FICTA_ANTHROPIC_UPSTREAM`, so an alt model (e.g. GPT‑5.6 "sol" behind CLIProxyAPI on a ChatGPT subscription) can run with redaction intact. Loopback upstreams need no `FICTA_ALLOW_CUSTOM_UPSTREAM`.
