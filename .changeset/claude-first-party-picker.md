---
"@serovaai/ficta": patch
---

`ficta claude` now sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` so Claude Code's `/model` picker lists current models (such as Fable 5.2) instead of a stale cached list. It also sets `DISABLE_ERROR_REPORTING=1`, since first-party mode would send crash reports directly to Anthropic. Memory sync is left on and goes directly to Anthropic, outside ficta; the threat model documents how to turn it off.
