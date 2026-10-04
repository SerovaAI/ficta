---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-engine": patch
"@serovaai/ficta-contract": minor
---

Make permanent removal of detected categories an opt-in setting editable from the control plane (`destroyCategories`, mapped to `dispositions.destroy.categories`; `"*"` stays TOML/env-only and locks the field), and turn it off in the Gateway reference deployment so detected values are restored by default.
