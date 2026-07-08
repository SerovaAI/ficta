## Unreleased

### Security

- Fixed a tool-argument redaction bypass: when a registry-secret surrogate (`FICTA_…`) was split across two streaming SSE fragments, the withhold path matched per fragment and never recognized the whole token, so the placeholder passed straight into tool-call arguments (and onto disk via `Write`) uncounted. The withhold branch now reassembles surrogates across fragments before deciding, so split tokens are withheld and counted exactly like whole ones. Registry/environment secrets are never restored into tool arguments regardless of policy.

### Added

- Added a personal Gateway default reasoning setting for OpenAI models.
- With both `FICTA_LOG_LEVEL=trace` and `FICTA_TRACE_AUDIT=1`, the proxy now writes `audit-XXXX.trace.json` sidecars with the raw protected values, surrogates, labels, and restored/withheld outcomes for that request, so demos and internal tests can prove exactly what was redacted and whether the answer restored it. These files use the same private permissions as raw body trace logs and are not emitted at lower log levels or without the explicit audit flag.
- At trace (`FICTA_LOG_LEVEL=trace`), the proxy also writes the client-bound, post-restore response body to `res-XXXX.restored.txt` (0600, capped by `FICTA_LOG_MAX_BYTES`) alongside the existing pre-restore `res-XXXX.txt`, so an incident can be replayed to show exactly which surrogates were restored into the client's bytes versus withheld from tool arguments.
- Added an `openmed` PII backend that calls the upstream OpenMed REST service (`/pii/extract`) directly as a sidecar container, selectable via `FICTA_PII_BACKENDS=presidio,openmed` and configured under `[pii.openmed]`; `ficta doctor` and the proxy status endpoint probe its `/health`.
- Added PII sidecar lifecycle management: `docker-compose.sidecars.yml` with `pnpm sidecars` / `pnpm sidecars:down` runs Presidio and OpenMed health-gated outside the dev wrapper, and root `pnpm dev` now auto-manages the sidecars for all backends selected via `FICTA_PII_BACKENDS` (previously only the legacy single `FICTA_PII_BACKEND=presidio`), including an OpenMed manager (upstream `ghcr.io/maziyarpanahi/openmed` image) with model preload and a persistent HF cache volume.
- Added source-checkout document-converter lifecycle management: root `pnpm dev` now builds/starts or reuses the local PDF/DOCX-to-Markdown sidecar by default (`FICTA_DOC_CONVERTER_MANAGED=0` opts out), and `pnpm sidecars` includes it alongside the PII sidecars. When Docker is unavailable the sidecar is skipped with a warning and `pnpm dev` still starts the proxy and web app, so contributors without Docker are not blocked; set `FICTA_DOC_CONVERTER_MANAGED=1` to make a converter failure fatal instead.
- Moved chat model selection into the composer with reasoning settings nested under the model control for OpenAI models.
- Added an admin-only Gateway redaction proof view backed by a values-free proxy stats endpoint.
- Added an opt-in restore-highlight visualization for the redaction-proof demo: with `FICTA_TRACE_AUDIT=1` the proxy wraps the values it restores into a response in highlight markers, and the Gateway renders them as highlighted spans in the chat answer while stripping the markers everywhere else — message storage, model replay, and the collapsed reasoning panel. Highlighting is applied consistently across streamed text, JSON, and the sibling fields of tool-adjacent events, so restored values are never shown with raw marker text.
- Added a live Gateway privacy display toggle for trace-audit restore highlights: restored spans now carry their surrogate metadata, and an icon-only top-bar control can switch the current chat view between restored values and `FICTA_…` surrogates without changing replay or storage.
- Split user settings and admin controls into separate popouts, with admin sections for general settings, proxy configuration, and redaction proof.

### Changed

- Updated public website Gateway positioning to lead with the self-hosted Gateway offer and move OSS install/source links into a supporting proof section.
- Replaced the public website hero wire demo with a balanced local-boundary artifact that shows protected values before send and tokenized model egress.
- Clarified the Gateway admin surrogate-style control with the config key, environment override, token-shape examples, and unchanged restore behavior.
- Removed individual-attribution wording from public website fallback, contact, and OSS proof copy.
- Changed Gateway proxy configuration controls to autosave on edit instead of requiring a form-level save button.
- Moved the Gateway admin entry into the signed-in user menu instead of showing it as a separate sidebar action.
- Moved the Gateway tool-call withholding runtime count out of proxy configuration and into redaction proof.
- Changed Gateway redaction proof to show aggregate protected keys and labels with counts instead of listing each request event.
- `FICTA_RESTORE_INTO_TOOLS` is now tri-state — `all` (restore every surrogate into tool arguments), `none` (withhold every surrogate), or `detected` (the new default: restore only content-derived detections such as secret-shapes/PII while withholding registry/environment secrets). Legacy `1`/`true` map to `all` and `0`/`false` to `none`. Rationale: a compromised model can already exfiltrate local file content without placeholders, so withholding content-derived detections only corrupted the agent's own files; registry secrets — which the model only ever saw as placeholders — keep strict withhold.
- Registered and detected multi-word values are now matched across serialized whitespace differences, so a value a document parser reflowed across a line break (e.g. `Proxima Medical\nSupplies CC`) is redacted instead of passing to the model. Matching stays token-exact: a whitespace separator must be present and may span at most one line break, so it never collapses concatenated tokens (`ProximaMedical`) or bridges a paragraph boundary.
- Reduced per-request work on the redaction, restore, and proof hot paths: trace-value hashing now runs only when audit logging is enabled, restore-highlight stripping is skipped when a payload has no markers, compiled redaction patterns are cached, per-value surrogate/provenance lookups share a single pass, and the proof view reuses one number formatter.

### Removed

- Removed the in-house `services/medical-pii-analyzer` wrapper service and ficta's `medical` PII backend (`FICTA_PII_MEDICAL_*` / `[pii.medical]`) — superseded by the `openmed` backend, which runs the upstream OpenMed service unmodified. Configs still selecting `medical` get the standard unknown-backend warning and fall back safely.

### Fixed

- Fixed the gitleaks GitHub Actions workflow by moving it to the current Node 24 action versions, passing the required organization `GITLEAKS_LICENSE` secret, and limiting scans to PR, scheduled, and manual runs.
- Hardened the public website with branded 404/error fallbacks, no-JS guidance, keyboard focus paths, and clipboard manual-copy recovery.
- Restored Gateway local-mode account-menu consistency by representing `AUTH_PROVIDER=none` as a local user and keeping Admin/Settings in the same menu shape used by hosted auth.
- Improved public website responsive behavior for tablet touch targets and very narrow mobile widths.
- Fixed Gateway admin proxy configuration so PII backend editing uses the multi-backend `FICTA_PII_BACKENDS` model and exposes OpenMed/medical detection alongside Regex and Presidio.
- Fixed Gateway admin model availability saves being reported as failed when the save succeeded but route refresh failed.
- Added a Gateway PGlite data-dir lock and startup probe so embedded storage fails clearly instead of double-opening or surfacing raw WASM aborts.
- Improved Gateway muted text contrast on quiet tinted surfaces.
- Fixed Gateway dev-server hangs from manual TanStack server-function prewarming and IPv6-only localhost binding.
- Fixed Gateway dev-server resolution of the local `@serovaai/ficta-protocol` workspace package.
- Aligned the published package-local pnpm pin with the workspace release toolchain so package publish scripts run under pnpm 11.10.0.
- Tightened secret-shape assignment detection so call/index expressions and code references are no longer misredacted: the captured value span now stops at `(` and `[`, and `isLikelySecretValue` rejects dotted identifier chains (`localStorage.getItem`, `envData.ADMIN_JWT_SECRET`) and bare mixed-case identifiers without digits (`getValidApiKeys`). Real API keys, JWTs, and credential URLs are unaffected.
