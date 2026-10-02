---
"@serovaai/ficta-engine": minor
---

Engine: add an irreversible "destroy" disposition. `dispositions.destroy.categories` replaces detections of the chosen categories with a fixed marker (default `[REDACTED_<CATEGORY>]`, overridable per category) instead of a reversible surrogate; destroyed values are never stored in the vault and are reported as `destroyed` plus `disposition: "destroy"` hits. Registered values keep their surrogates.
