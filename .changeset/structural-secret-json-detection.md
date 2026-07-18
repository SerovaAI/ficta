---
"@serovaai/ficta": patch
---

Fix secret-shape detection false positives that could misread an adjacent JSON object key as a secret value and corrupt the forwarded request body: JSON key→value secrets are now detected structurally from body leaves (new optional `detectBodyLeaves` plugin hook), and the pattern-detection view separates leaves with a boundary no match can cross.
