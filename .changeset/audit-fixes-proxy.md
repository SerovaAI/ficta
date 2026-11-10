---
"@serovaai/ficta": patch
---

Fix several audit findings: an agent killed by a signal no longer makes `ficta` exit 0, `ficta setup` no longer resets a hand-set `registry.require` or `redaction.fail_closed`, a failed response-log write can no longer exit the proxy, the email detector no longer goes quadratic on long unbroken runs, `detection.entityPriority` now holds on later turns of a scope, and a typed-style value named like an `Object.prototype` member gets a valid surrogate. Docs corrected (plugin example, OpenMed backend name, control-plane response openness).
