---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-contract": patch
---

Surface the `restore_prose` policy in the operator-facing read surfaces: `ficta doctor` now reports it (and flags the default `all`, which leaves registry secrets rehydrated into assistant text, mirroring the existing `restore_into_tools=all` warning), and the `/__ficta/config` posture includes `protection.restoreProse`. Read-only visibility only — it is not added to the Gateway admin editable keys; set it via `restore_prose` / `FICTA_RESTORE_PROSE`.
