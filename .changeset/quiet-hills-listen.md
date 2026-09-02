---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
---

Fix Claude Code sessions stalling on `429 Error · Retrying` once a tool result is redacted. The surrogate-preservation instruction is now appended to an Anthropic `system` prompt instead of prepended: api.anthropic.com rejects Claude Code subscription requests whose first system block is not the client's billing header, and prepending also invalidated the cached system prefix on every redacted turn. Launched agents now inherit only the shell's own `FICTA_*` variables, not ficta's merged runtime settings, so a nested `claude` launch honours `pii.agents = false` instead of treating the inherited `FICTA_PII_ENABLED=1` as an explicit override and requiring the Presidio sidecar.
