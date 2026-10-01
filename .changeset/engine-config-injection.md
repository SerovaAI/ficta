---
"@serovaai/ficta": patch
---

The redaction engine no longer reads environment variables: `ProtectionEngine` takes its settings (surrogate key and style, PII and secret-shape detection, fail-closed detection, restore-into-tools, path redaction, registry exclusions) as a `config` object and warnings through an `onWarn` sink, so several engines in one process can run with different settings. The ficta CLI and proxy build that config from env and `config.toml` once at startup, so their behaviour is unchanged. Plugin authors: detect contexts, `discover()` and `failClosed()` now receive a `runtime` carrying the calling engine's config and warn sink.
