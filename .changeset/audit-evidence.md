---
"@serovaai/ficta": minor
"@serovaai/ficta-engine": patch
---

`ficta logs audit` keeps its evidence. Before log pruning deletes a session's raw traces, ficta now audits them and saves the values-free report under `~/.ficta/logs/audits/`, and `ficta logs audit --save` saves one on demand. Each audit ends with a total over the saved reports: requests audited, capture units, and distinct leak findings. The audit also lists the plain protected values it sees inside file paths, reports a credential-looking value inside a path as a leak (redaction never keeps one there), and no longer flags Claude Code's device id in `metadata.user_id`. The engine exports `looksLikeCredentialMaterial` and `isClaudeCodeUserId` so the audit and redaction use the same rules.
