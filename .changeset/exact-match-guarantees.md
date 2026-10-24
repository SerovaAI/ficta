---
"@serovaai/ficta-engine": patch
---

Fix two exact-match guarantee gaps. A registered value that JSON-escapes (a quote, backslash or newline) is now redacted and leak-checked inside OpenAI tool-call `arguments`, which carry JSON text inside a JSON string. A registry secret that a detector also sees in a header or query string now stays a registry secret, so the default `restore_into_tools=detected` keeps withholding it from tool calls, including in keyed scopes whose stores hold a detected copy written by an earlier release.
