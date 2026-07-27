---
"@serovaai/ficta": patch
---

Document the secret-shape detector's known coverage limits. The plugin docs described what the detector catches but not what it deliberately does not, which invites the assumption that enabling it covers any secret in any config an agent reads. A new "Known coverage limits" section records the three key/value pairing positions where an opaque value is missed and why each is not simply widened, plus the path-shaped-value rejection so that behaviour reads as intentional. The threat model's "Intentionally not covered" list gains a matching entry for best-effort detector misses.
