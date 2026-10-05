---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-engine": patch
---

Residual-surrogate guard, Phase 2: once the proxy is protecting, a surrogate-shaped token that survives restore in client-visible text (a mutated/invented token, or an unmappable reference from another scope) is replaced with the neutral marker `[ficta:unrestored]` instead of reaching the agent as a raw `FICTA_…` string it might echo into a file. Mapped tokens — including deliberately withheld tool-call placeholders — are untouched, so only genuine debris is rewritten, and the no-cross-request-leak guarantee is unchanged. The marker for the client-requested `x-ficta-unknown-token: replace` preview is unified to the same string.
