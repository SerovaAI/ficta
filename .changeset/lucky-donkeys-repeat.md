---
"@serovaai/ficta": patch
---

Stop the secret-shape detector from redacting file paths out of tool output. The `secret-json-value` pattern requires no separator between key and value, so any line ending in a token containing a secret-ish word (`.../rotateToken`, `useAuth.ts`, a comment ending `registered-secret`) caused the entire next whitespace-delimited token to be captured as a secret — silently removing roughly one path per 150 from any `git diff --name-only`, `ls`, `find`, or grep listing a coding agent reads, and keeping it redacted for the rest of the proxy's lifetime. Values that look like multi-segment filesystem paths, including `path:line` locators, are now rejected unless a segment looks like credential material.
