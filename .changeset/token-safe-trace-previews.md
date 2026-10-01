---
"@serovaai/ficta": patch
---

Trace-log previews of upstream responses no longer cut a surrogate token in half; a token that straddles the preview limit is dropped whole, so a cut preview can't be mistaken for a model-truncated surrogate.
