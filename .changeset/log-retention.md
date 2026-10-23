---
"@serovaai/ficta": minor
---

Prune capture logs automatically: agent launches and the standalone proxy (at most hourly) delete capture dirs idle for 14 days, then the oldest until `~/.ficta/logs` is under 1 GiB, and raw-value trace files after 24 hours; dirs still in use are never removed. Configure with `[logging] retain_days`, `max_total_bytes`, `trace_retain_hours` (0 disables). New `ficta logs` / `ficta logs prune [--traces]` command, and `ficta doctor` shows the retention policy. Also fixes `FICTA_DEV_TRACE` so its 16 MiB capture limit applies instead of the 256 KiB default.
