---
"@serovaai/ficta": patch
---

`ficta claude` now sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` so Claude Code's `/model` picker lists current models (such as Fable 5.2) instead of a stale cached list, and sets `CLAUDE_CODE_DISABLE_ORG_MEMORY=1` because org memory sync would upload memory files to Anthropic without going through ficta.
