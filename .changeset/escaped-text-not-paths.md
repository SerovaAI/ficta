---
"@serovaai/ficta-engine": patch
"@serovaai/ficta": patch
---

Fix a leak: a registered value next to a JSON escape in serialized text (`<value>\nNext`, `\"<value>\"`, `\t<value>`) was sent unreplaced, because the escape's backslash made the word look like a Windows path and path preservation kept it. Claude Code's auto-mode classifier sends the transcript this way, so a registered client name or matter code could leave in that side request even though the main conversation protected it. Escape sequences no longer count as path separators. Real Windows paths still keep plain names usable.
