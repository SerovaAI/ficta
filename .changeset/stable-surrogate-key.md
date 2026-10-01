---
"@serovaai/ficta": minor
---

The surrogate key can now come from a private key file: `surrogate.key_file` / `FICTA_SURROGATE_KEY_FILE` (64 hex characters, not readable by group or others). `surrogate.require_stable_key` / `FICTA_REQUIRE_STABLE_SURROGATE_KEY` makes the proxy and agent launches fail at startup instead of falling back to a random per-process key. `ficta doctor` reports whether the surrogate key is stable or ephemeral and where it comes from, without printing it. The key is now resolved when the proxy starts rather than at module import.
