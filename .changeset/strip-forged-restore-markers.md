---
"@serovaai/ficta-engine": patch
---

Neutralize restore-highlight delimiters written by the upstream model (raw or JSON-escaped, in a single linear pass) before restoring, so a model can't forge a "restored from registry" highlight or shield a leftover placeholder from unknown-token replacement.
