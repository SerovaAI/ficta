---
"@serovaai/ficta-engine": patch
---

Secret-shape detection no longer redacts hex digests whose label names them as one (`sha256: …`, `"commit": "…"`, `checksum=…`, `git log`'s `commit …`) or Subresource Integrity values (`integrity: sha512-…`), so agents can still edit and verify hashes verbatim. Bare unlabelled hex values, and digests under a label that also names a secret (`api_key_sha256`), are still treated as opaque secrets.
