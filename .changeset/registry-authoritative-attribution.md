---
"@serovaai/ficta": patch
---

Audit attribution now prefers the registry's identity when a value is both a registered secret and a probabilistic detection: the trace/stats report `env-file / secret / exact` (e.g. `CLIENT_CFO`) instead of the detector's guess (`person / pii / high`). Reporting only — span selection, surrogates, restore, and restore-into-tools provenance are unchanged.
