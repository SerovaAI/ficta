---
"@serovaai/ficta": patch
---

Secret-shape detection now catches a password after a label in prose (`Password: hunter2`, `pwd=…`, `…, password: s3cret!, …`), including short values, and recognises the German labels `Passwort` and `Kennwort`. Already-redacted values (Ficta surrogates and `[REDACTED…]` markers) after a password label are left alone.
