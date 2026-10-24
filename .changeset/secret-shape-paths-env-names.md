---
"@serovaai/ficta-engine": patch
---

Stop the secret-shape detector from flagging two kinds of ordinary text: absolute filesystem paths (an agent's scratchpad or temp directory, read as one long opaque token), and an environment variable name that follows a secret-ish name in a listing (`JWT_PRIVATE_KEY` then `RESEND_API_KEY`, read as a name and its value). Both were redacted on some turns and not others.
