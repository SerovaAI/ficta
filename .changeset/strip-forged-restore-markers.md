---
"@serovaai/ficta-engine": patch
---

Remove restore-highlight marker delimiters written by the upstream model before restoring, so a model can't forge a "restored from registry" highlight or shield a leftover placeholder from unknown-token replacement.
