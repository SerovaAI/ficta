---
"@serovaai/ficta-engine": patch
---

Stop the secret detectors from screening a request's top-level `metadata.user_id` when it is exactly Claude Code's telemetry identifier (a 64-hex device id, account UUID, and session UUID, nothing else). Claude Code sends that on every request, which was replaced as an `opaque-secret`, so nearly every request counted a protected value and got the surrogate-preservation instruction even when nothing in the conversation was secret. Registered values in that field are still replaced.
