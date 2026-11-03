---
"@serovaai/ficta-engine": patch
"@serovaai/ficta": patch
---

Fix a leak: a protected value that looks like a credential (a known token prefix, long hex, or a long random mixed-case string) was sent to the provider unreplaced whenever it sat in a path-like word, such as `<sha>..origin/main`, `host/v1/<key>`, `/tmp/<token>/out`, or `fatal: bad revision '<value>..origin/main'`. The leak gate skipped the same occurrences, so nothing was blocked. Path preservation now applies only to plain names such as regions, profiles, and project directories. The preserve-literals instruction also lists only surrogates the model can see, not ones that appear only in `metadata` or other client fields. The model had once copied such a token into a shell command, and the real value then reached the provider.
