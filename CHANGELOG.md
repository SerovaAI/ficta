## Unreleased

### Added

- Added a personal Gateway default reasoning setting for OpenAI models.
- Added an `openmed` PII backend that calls the upstream OpenMed REST service (`/pii/extract`) directly as a sidecar container, selectable via `FICTA_PII_BACKENDS=presidio,openmed` and configured under `[pii.openmed]`; `ficta doctor` and the proxy status endpoint probe its `/health`.
- Added PII sidecar lifecycle management: `docker-compose.sidecars.yml` with `pnpm sidecars` / `pnpm sidecars:down` runs Presidio and OpenMed health-gated outside the dev wrapper, and root `pnpm dev` now auto-manages the sidecars for all backends selected via `FICTA_PII_BACKENDS` (previously only the legacy single `FICTA_PII_BACKEND=presidio`), including an OpenMed manager (upstream `ghcr.io/maziyarpanahi/openmed` image) with model preload and a persistent HF cache volume.
- Moved chat model selection into the composer with reasoning settings nested under the model control for OpenAI models.
- Added an admin-only Gateway redaction proof view backed by a values-free proxy stats endpoint.
- Split user settings and admin controls into separate popouts, with admin sections for general settings, proxy configuration, and redaction proof.

### Changed

- Changed Gateway proxy configuration controls to autosave on edit instead of requiring a form-level save button.
- Moved the Gateway admin entry into the signed-in user menu instead of showing it as a separate sidebar action.
- Moved the Gateway tool-call withholding runtime count out of proxy configuration and into redaction proof.

### Removed

- Removed the in-house `services/medical-pii-analyzer` wrapper service and ficta's `medical` PII backend (`FICTA_PII_MEDICAL_*` / `[pii.medical]`) — superseded by the `openmed` backend, which runs the upstream OpenMed service unmodified. Configs still selecting `medical` get the standard unknown-backend warning and fall back safely.

### Fixed

- Fixed Gateway admin model availability saves being reported as failed when the save succeeded but route refresh failed.
- Improved Gateway muted text contrast on quiet tinted surfaces.
- Fixed Gateway dev-server hangs from manual TanStack server-function prewarming and IPv6-only localhost binding.
- Fixed Gateway dev-server resolution of the local `@serovaai/ficta-protocol` workspace package.
