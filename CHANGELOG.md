## Unreleased

### Added

- Moved chat model selection into the composer alongside a per-chat reasoning level control for OpenAI models.
- Added an admin-only Gateway redaction proof view backed by a values-free proxy stats endpoint.
- Split user settings and admin controls into separate popouts, with admin sections for general settings, proxy configuration, and redaction proof.

### Fixed

- Fixed Gateway dev-server hangs from manual TanStack server-function prewarming and IPv6-only localhost binding.
- Fixed Gateway dev-server resolution of the local `@serovaai/ficta-protocol` workspace package.
