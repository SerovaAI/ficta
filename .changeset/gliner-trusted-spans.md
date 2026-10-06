---
"@serovaai/ficta": patch
---

Presidio sidecar: the opt-in GLiNER NER mode now keeps confident spans (`FICTA_PRESIDIO_GLINER_TRUST_SCORE`, default 0.7) that the spaCy-shaped name gates used to drop and sends only identity labels to the model; spans made only of office titles such as "Acting Judge" are no longer treated as people. spaCy remains the default.
