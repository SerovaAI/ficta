---
"@serovaai/ficta": minor
---

Add `ficta logs audit [--json]`, which replays dev-trace captures and reports any protected value that reached the provider, any registry secret restored into a tool call, and unreplaced secret-shaped strings to review. Each launch is checked against its own protected values. The report shows hashes and labels, never values, and the command exits 1 on a leak.
