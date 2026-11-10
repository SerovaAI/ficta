---
"@serovaai/ficta-contract": patch
---

The OpenAPI document now lists both required headers (`x-ficta-scope` and `x-ficta-egress-event`) on `GET /__ficta/egress-proof`; the generator previously kept only the last one.
