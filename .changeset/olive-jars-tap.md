---
"@serovaai/ficta": patch
---

Escape restored values spliced into streamed tool-call arguments. A tool-argument fragment is itself JSON text that the client concatenates and parses, but the tool-argument restore path returned the value raw where the response-body path escapes it for its string context. A restored value containing a newline, `"`, or `\` — a PEM key, a quoted password, any multi-line file content the agent was writing back — therefore produced invalid JSON and corrupted the tool call. Both the withholding policies and `all` route through the escaping path now.
