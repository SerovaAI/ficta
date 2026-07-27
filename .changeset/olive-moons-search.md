---
"@serovaai/ficta": patch
---

Detect secrets behind quoted keys on text surfaces. The `secret-assignment` pattern required the separator to follow the key directly, so a quoted key — the normal form in JSON — never matched: the closing quote sits between key and `:`, and `\s*` cannot cross it. A JSON config read into a tool result is text rather than a request body, so the structural key→value pairing does not apply to it either, leaving values like `{"api_token": "…"}` undetected unless they carried a recognizable vendor shape. Allowing an optional closing quote after the key covers same-line, pretty-printed, and line-wrapped JSON as well as single-quoted YAML keys.
