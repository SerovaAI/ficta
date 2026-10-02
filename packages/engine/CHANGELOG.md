# @serovaai/ficta-engine

## 0.5.0

### Minor Changes

- [#108](https://github.com/SerovaAI/ficta/pull/108) [`ac2aeb3`](https://github.com/SerovaAI/ficta/commit/ac2aeb37b379070826e814cca59568011bc0a1ef) Thanks [@steflsd](https://github.com/steflsd)! - New package `@serovaai/ficta-engine` (experimental, 0.x): the redaction engine as a standalone library with no runtime dependencies, so other services can redact and restore in-process. It ships the built-in detectors as its default plugin set, adds `redactContentDetailed` for redacting plain strings as message content (every detector runs, including Presidio/OpenMed), and requires an explicit `config.surrogate.key` unless the caller passes `allowEphemeralKey: true`. `@serovaai/ficta` now builds on it and releases with it at the same version; the ficta CLI keeps its ephemeral-key fallback, and the `@serovaai/ficta/plugins` API is unchanged.
