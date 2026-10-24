---
"@serovaai/ficta-engine": patch
---

Scan and forward request bodies literal by literal. A value hidden behind a duplicate JSON key (`{"content":"<secret>","content":"hi"}`) is now redacted and seen by the leak gate, where before the parse kept only the last value while the original bytes, secret included, were forwarded. Redaction no longer re-serializes the body, so integers above 2^53 and formatting reach the provider unchanged. A registered value written inside token-shaped text that this scope never minted (a 32-hex key written as `FICTA_<key>`) is now redacted and leak-checked instead of being exempt.
