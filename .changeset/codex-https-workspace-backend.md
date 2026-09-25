---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
---

Fix `codex` failing to start under ficta on Codex 0.156+ (`workspace backend must use an HTTPS origin`): ficta no longer overrides `chatgpt_base_url`, so Codex account/plugin/usage housekeeping goes direct while model turns still route through ficta, and wrapped launches now set `analytics.enabled=false` because Codex analytics events carried registered values.
