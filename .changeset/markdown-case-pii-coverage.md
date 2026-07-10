---
"@serovaai/ficta": patch
---

Close two systemic PII-miss classes observed on markitdown-converted documents:

- **Markdown-aware NER input**: NLP backends (Presidio/OpenMed) now detect over compact Markdown-normalized text with exact raw-offset mapping (`**bold**`, `\_` escapes, `###` headings, list markers, `~~strike~~`), fixing contaminated spans, internal-formatting gaps, and recall lost to formatting; regex recognizers keep the raw text.
- **Case-variant coverage**: an entity detected in one casing is redacted in every casing actually present in the request (title-case prose vs ALL-CAPS headings/signature blocks), for detected PII and word/name-like registry values alike (digit-bearing secrets are never case-folded). Registry-derived variants carry `permanent` provenance, so the `detected` restore-into-tools policy withholds a secret's case twin from tool-call arguments exactly like the canonical form.
