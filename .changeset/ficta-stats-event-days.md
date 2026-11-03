---
"@serovaai/ficta": patch
---

`ficta stats` now dates protection by when each redaction happened, so `--since` and the by-day breakdown no longer pile a long-running session's activity onto the day it started. It also shows how many logged sessions protected something (for example `17 of 55 sessions`), counting sessions that never wrote a stats file.
