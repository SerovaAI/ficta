---
"@serovaai/ficta": patch
---

Neutralize caller-provenance labels: explicit pre-send selections are now recorded with
`source: "user-selected"` and `plugin: "protection-preview"` (previously `gateway-user` /
`gateway-preview`). The strings appear in protection-preview findings, traces, and stats labels;
no behavior depends on them.
