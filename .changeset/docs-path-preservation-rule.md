---
"@serovaai/ficta": patch
---

Docs: the threat model and plugin guide now describe the path rule as it works since 0.12.0. Only plain-looking registered values are left in place inside file paths. Credential-looking values are replaced even there, and JSON-escaped text never counts as a path. `ficta logs audit` lists what the exception kept.
