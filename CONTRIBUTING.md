# Contributing to the Ficta monorepo

Contribution guidelines — what we optimize for, core vs plugin seams, and how to change product or
security claims — live in [`packages/ficta/CONTRIBUTING.md`](packages/ficta/CONTRIBUTING.md). Read
that and the [threat model](packages/ficta/docs/threat-model.md) first. This page covers the
monorepo toolchain.

Every user-facing change to a published package needs a changeset (`pnpm changeset`); see
[`AGENTS.md`](AGENTS.md) for the rules.

## Development

The monorepo toolchain requires Node.js 22.13 or newer. The published CLI and protocol packages keep
their own Node.js `>=20` runtime support.

```sh
pnpm install
pnpm dev             # proxy + Gateway; auto-uses Doppler when configured, otherwise local .env
pnpm dev:proxy       # proxy only
pnpm gateway:dev     # Gateway only
pnpm sidecars        # document converter + Presidio via docker-compose.sidecars.yml
pnpm sidecars:openmed # additionally start the opt-in OpenMed PII backend
pnpm sidecars:down
pnpm sidecars:check  # check upstream image digests; add --openmed to include OpenMed
pnpm sidecars:update # upgrade Presidio pin, rebuild and recreate; add --openmed if used
pnpm check:with-sidecars # alias for pnpm check
pnpm check           # advisory sidecar version check, static checks, type checks, and tests
pnpm build
```

`sidecars:check` needs Docker with Buildx, a running Docker daemon, and registry access. It reports
whether Presidio's checked-in base digest differs from the latest stable upstream release tag, and whether the local
converter's recorded Python base (falling back to the cached base for older images) and optionally
OpenMed differ from their configured registry references.
Updates are informational; registry/Docker errors fail the standalone command. `pnpm check` starts
with this check in advisory mode: updates are reported, and unavailable Docker or registry access
produces a warning without failing the checks. It never updates or restarts sidecars.
`pnpm check:with-sidecars` is an alias for `pnpm check`. Lint, formatting, test, and workspace check
failures still fail normally.

`sidecars:update` skips images whose recorded source/build inputs and upstream digest are unchanged.
Changed or missing images build with Docker caching; Compose reuses unchanged containers and applies
configuration changes. The command updates the Presidio Dockerfile digest
to the latest stable upstream release tag and digest after a successful build, and converges the Compose services with health checks.
Use `pnpm sidecars:update --force` for an uncached rebuild and forced restart (optionally add
`--openmed`). Existing images without input metadata need one cached build to establish it.
A forced rebuild re-resolves converter Python dependencies but leaves fixed Pandoc, optional GLiNER/torch, and model
versions unchanged; the check does not inspect those dependencies or running-container versions.
OpenMed defaults to a stable version tag and digest shared by Compose and dev. With `--openmed`,
the updater advances that default to the latest stable release; explicit `OPENMED_IMAGE` overrides
from Compose and `.env` are pulled as configured. Release discovery uses GitHub's stable-release API;
there is no fallback to the floating `latest` image tag.
Stop a foreground `pnpm dev` first if it owns the sidecar ports. Changed services may restart;
review any changed Presidio pin, run detector regressions, and add a changeset before committing it.

`pnpm dev` is for developing the proxy and Gateway together. It also auto-manages the Gateway
document-converter sidecar by default, plus the PII sidecars for whichever backends
`FICTA_PII_BACKENDS` selects, reusing any already-running (e.g. compose-started) containers. The
coding agents do not use it -
`ficta claude|codex|pi` starts its own ephemeral proxy per launch (see
[`docs/install.md`](packages/ficta/docs/install.md)).
