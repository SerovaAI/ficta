---
"@serovaai/ficta": patch
---

Close two systemic PII-miss classes observed on markitdown-converted documents:

- **Markdown-aware NER input**: NLP backends (Presidio/OpenMed) now detect over Markdown-normalized text (equal-length masking of `**bold**`, `\_` escapes, `###` headings, list markers, `~~strike~~`), fixing contaminated spans and recall lost to formatting; regex recognizers keep the raw text. Detected spans are trimmed before registration.
- **Case-variant coverage**: an entity detected in one casing is redacted in every casing actually present in the request (title-case prose vs ALL-CAPS headings/signature blocks), for detected PII and word/name-like registry values alike (digit-bearing secrets are never case-folded). Registry-derived variants carry `permanent` provenance, so the `detected` restore-into-tools policy withholds a secret's case twin from tool-call arguments exactly like the canonical form.
