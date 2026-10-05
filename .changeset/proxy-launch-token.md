---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": minor
"@serovaai/ficta-engine": minor
---

Proxy: gate the per-agent proxy with a per-launch caller token. The CLI mints a random token and bakes it into the launched agent's base URL (`/__ficta_l/<token>/…`); the proxy strips and verifies it before routing — and never forwards it upstream — refusing any provider-bound request that does not carry it (a health probe stays exempt). This stops another process sharing the loopback port from using the proxy to restore a known placeholder to its real value. The launched agent carries the token transparently, so no agent configuration changes. `startProxy` takes a new optional `launchToken`; omit it (as the multi-tenant Gateway proxy does) to keep the prior behavior.
