---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
---

Live protected registry: values published from the gateway admin UI take effect in the running proxy without a restart. New `POST /__ficta/registry/reload` (loopback-gated, request body ignored, counts-only response including `skippedTooShort` for values below `FICTA_REGISTRY_MIN_LEN`), `ProtectionEngine.reloadRegistryValues()` registering new managed-file values into the live vault, and a stat-based cache key for the managed-registry plugin (a rewritten file is actually re-read — also fixes stale registry counts in per-request log metadata and `ficta doctor`). Additions are live; deletions still apply on restart (removing a value mid-process would break restore of surrogates already in transcripts). Protocol gains `FICTA_REGISTRY_RELOAD_PATH`, `RegistryReloadOk/Error`, and `isRegistryReloadOk`.
