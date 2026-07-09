---
"@serovaai/ficta": patch
---

Separate capture logs by proxy role so concurrent instances no longer share one directory. The
standalone/web server now writes under `~/.ficta/logs/gateway/`, and each `ficta <agent>` shim under
`~/.ficta/logs/agents/<agent>/<instance>/` (one subtree per process, so two `ficta claude` sessions
never interleave `runs/` or race `protection-stats.json`). Set `FICTA_LOG_ROOT` to relocate the root;
`FICTA_LOG_DIR` still fully overrides the exact path. Existing `config.toml` files whose
`[logging].log_dir` equals the default root are treated as neutral so the split applies.
