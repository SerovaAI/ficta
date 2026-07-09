---
"@serovaai/ficta": patch
---

Detect organization names via Presidio NER. Ship an NLP-engine config (`presidio/nlp_engine.za.yaml`, mounted as `NLP_CONF_FILE`) that un-suppresses `ORGANIZATION` — upstream ignores it as "many false positives" — so unregistered client/counterparty/company names get a best-effort catch from spaCy `en_core_web_lg`. This is probabilistic and over-redacts (headings, common nouns); exact confidentiality still comes from the registered-value registry.
