---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
---

Harden live Protected Registry publication: Gateway now writes private registry files atomically, serializes publish transactions, and verifies a per-generation revision echoed by the proxy together with managed-source health counts. Hosted Gateway deployments are explicitly bound to one WorkOS organization via `FICTA_GATEWAY_ORG_ID`, matching the proxy's process-global permanent registry.
