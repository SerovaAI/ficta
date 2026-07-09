![ficta — a local secret airlock for coding agents](https://raw.githubusercontent.com/SerovaAI/ficta/main/assets/ficta-overview.png)

# @serovaai/ficta

[Website](https://ficta.sh)

Local redaction proxy for coding-agent model traffic. `ficta` sits between a supported CLI agent and
the model provider, replaces registered secret values with deterministic placeholders before requests
leave your machine, and restores them locally on the response — so tools keep seeing those protected
values while the provider sees surrogates. Optional request-time detectors add best-effort tokenization
for pasted secret-shaped values and PII; they are a reduction layer, not the exact-match guarantee
registered secrets receive.

For the full pitch, threat model, and what's in/out of scope, see the
[project overview](https://ficta.sh) and
[`docs/threat-model.md`](./docs/threat-model.md). This page is the practical install-and-configure
reference. Ficta Gateway, the self-hosted internal chat UI, uses the same proxy but has a separate
operator guide in the repository's
[`apps/gateway/README.md`](https://github.com/SerovaAI/ficta/tree/main/apps/gateway#readme).

## Install

```sh
npm install -g @serovaai/ficta
# or: pnpm add -g @serovaai/ficta  /  bun install --global @serovaai/ficta
```

## Setup

```sh
ficta setup              # writes ~/.ficta/config.toml; optionally installs shims
ficta doctor claude      # sanity-check registry loading + routing (or: codex / pi)
# restart your shell if setup installed shims
claude                   # now runs through ficta
```

Without shims, launch explicitly: `ficta claude` (or `ficta codex` / `ficta pi`). Non-model commands
like `--help` / `--version` pass straight through without starting a proxy. Shim details are in
[`docs/install.md`](./docs/install.md).

## Configuration

`ficta setup` writes **`~/.ficta/config.toml`**. Every option can be overridden by a `FICTA_*` shell
environment variable, and **env vars always win over the file**. Point at a different file with
`FICTA_CONFIG_FILE`.

[`config.toml.example`](./config.toml.example) is the authoritative, fully annotated reference for
every option. The table below is just a quick tour of the most useful knobs:

| TOML | Env override | Default | What it does |
| --- | --- | --- | --- |
| `registry.min_len` | `FICTA_REGISTRY_MIN_LEN` | `8` | Ignore registered values shorter than this. |
| `registry.require` | `FICTA_REQUIRE_REGISTRY` | `false` | Refuse to launch if no protected values load. |
| `registry.env_file.paths` | `FICTA_REGISTRY_ENV_FILE_PATHS` | `.env,.env.local` | Env files to load values from. |
| `registry.managed_file.paths` | `FICTA_REGISTRY_MANAGED_FILE_PATHS` | `.data/protected-registry.json` | Managed registry JSON files for admin-approved business values. |
| `registry.process_env.mode` | `FICTA_REGISTRY_PROCESS_ENV_MODE` | `secret-ish` | `secret-ish` name-matching or `all` process env. |
| `redaction.fail_closed` | `FICTA_FAIL_CLOSED` | `true` | Block a request if a protected value survives redaction. |
| `redaction.redact_paths` | `FICTA_REDACT_PATHS` | `false` | Also redact path-like tokens in the query string and body (headers always redact them). |
| `detection.fail_closed` | `FICTA_FAIL_CLOSED_DETECTION` | `false` | Global default for detector-backend outages: block instead of skip detection. |
| `secret_shapes.enabled` | `FICTA_SECRET_SHAPES_ENABLED` | unconfigured: `false`; after `ficta setup`: prompted, default `true` | Best-effort request-time detection of known secret shapes for the standalone/web proxy. |
| `secret_shapes.agents` | `FICTA_SECRET_SHAPES_AGENTS` | `false` | Also enable secret-shape detection for `ficta claude|codex|pi` launches when `secret_shapes.enabled` is on. |
| `pii.enabled` | `FICTA_PII_ENABLED` | unconfigured: `false`; after `ficta setup`: prompted, default `true` | Best-effort PII detection for the standalone/web proxy. |
| `pii.agents` | `FICTA_PII_AGENTS` | `false` | Also enable PII detection for `ficta claude|codex|pi` launches when `pii.enabled` is on. |
| `pii.backend` | `FICTA_PII_BACKEND` | `regex` | Legacy single PII backend selector. |
| `pii.backends` | `FICTA_PII_BACKENDS` | unset → `pii.backend` | PII backend set, e.g. `presidio,openmed`. |
| `pii.fail_closed` | `FICTA_PII_FAIL_CLOSED` | `false` | PII-specific detector-outage policy; overrides `detection.fail_closed`. |
| `pii.presidio.url` | `FICTA_PII_PRESIDIO_URL` | local Presidio sidecar URL | Analyzer URL when the backend set includes `presidio`. |
| `pii.openmed.url` | `FICTA_PII_OPENMED_URL` | local OpenMed service URL | Service URL when the backend set includes `openmed`. |
| `surrogate.style` | `FICTA_SURROGATE_STYLE` | `opaque` | Token style: `opaque` (`FICTA_<hex>`) or `typed` (`FICTA_PERSON_…`, `FICTA_SSN_…`) for model fluency; reversibility unchanged. |
| `logging.log_root` | `FICTA_LOG_ROOT` | `~/.ficta/logs` | Root for capture logs. Each proxy writes to a per-role subtree so concurrent instances never collide: the standalone/web server under `gateway/`, and every `ficta claude\|codex\|pi` shim under `agents/<agent>/<instance>/` (one per process). Each subtree holds its own `ficta.log`, `protection-stats.json`, and lazy `runs/run-*` captures. |
| `logging.log_dir` | `FICTA_LOG_DIR` | unset | Full override of the exact capture-log path (bypasses the root+role split for all roles). |
| `upstreams.anthropic` | `FICTA_ANTHROPIC_UPSTREAM` | Anthropic API | Override the Anthropic upstream (also `..._OPENAI_...` / `..._CHATGPT_...`). |

**Registry sources** — managed registry files, env-file, process-env, and Doppler discovery — have
their own config under `[registry.*]`; see
[`docs/plugins.md`](./docs/plugins.md#configuring-built-in-plugins) for the per-source options
(Doppler `configs` / `project` / `timeout_ms`, etc.).

**Request-time detectors** are intentionally per-surface. The standalone/web proxy follows
`secret_shapes.enabled` and `pii.enabled`. A launched coding agent gets those detectors only when both the
matching `enabled` and `agents` toggles are true, unless you explicitly set `FICTA_SECRET_SHAPES_ENABLED`
or `FICTA_PII_ENABLED` for that single run.

**Secret-shape detection** catches newly pasted values that are not already in the registry, such as
common API key prefixes, JWTs, PEM private keys, credential URLs, and secret-ish assignments. It is
local and pattern-based; it does not verify credentials and does not replace the stronger exact-match
registry layer.

**Presidio is a first-class supported PII backend.** Select it with `pii.backend = "presidio"` /
`FICTA_PII_BACKEND=presidio`, or as part of `pii.backends = ["presidio", "openmed"]` /
`FICTA_PII_BACKENDS=presidio,openmed`; ficta will call the configured `presidio-analyzer` URL, check
`/health` in `ficta doctor` and the web UI status endpoint, and apply the configured
fail-open/fail-closed detector-outage policy. In a source checkout, `pnpm sidecars` (repo-root
`docker-compose.sidecars.yml`) starts the Gateway document converter plus Presidio and OpenMed
health-gated, and root `pnpm dev` auto-manages the document converter by default plus the PII
sidecars for the backends selected via `FICTA_PII_BACKENDS` / `FICTA_PII_BACKEND`, reusing anything
already running. For coding-agent or installed use, you can
also run the analyzer sidecar explicitly before launching the agent:

```sh
docker run --rm -p 5002:3000 \
  -v "$PWD/packages/ficta/presidio/default_recognizers.za.yaml:/app/ficta-presidio-recognizers.yaml:ro" \
  -e RECOGNIZER_REGISTRY_CONF_FILE=/app/ficta-presidio-recognizers.yaml \
  ghcr.io/data-privacy-stack/presidio-analyzer:latest

FICTA_PII_ENABLED=1 \
FICTA_PII_BACKEND=presidio \
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002 \
ficta claude
```

The committed registry config keeps Presidio's default recognizers, enables `ZA_ID_NUMBER`, and adds
`ZA_COMPANY_REGISTRATION` for South African company registration numbers.

For medical workspaces that need both general PII and medical/PHI-style identifiers, run the
upstream OpenMed REST service alongside Presidio (published image
`ghcr.io/maziyarpanahi/openmed`, started by `pnpm sidecars` or `pnpm dev`), and set
`FICTA_PII_BACKENDS=presidio,openmed`. Ficta coordinates both external
analyzers natively, merges
detected values, and applies the same fail-open/fail-closed detector policy. Treat this as
best-effort reduction, not a clinical de-identification guarantee, and use `FICTA_PII_FAIL_CLOSED=1`
for medical workflows that should block when any selected analyzer is unavailable.

See [`docs/plugins.md#built-in-detector-plugin-pii`](./docs/plugins.md#built-in-detector-plugin-pii)
for backend selection, Presidio sidecar setup, and fail-open/fail-closed behavior when a detector
backend is unavailable.
See [`docs/plugins.md#built-in-detector-plugin-secret-shapes`](./docs/plugins.md#built-in-detector-plugin-secret-shapes)
for the request-time secret-shape detector's web/agent surfaces and pattern-based limits.

### One-off overrides

```sh
FICTA_REQUIRE_REGISTRY=1 claude   # refuse to launch if nothing loads
FICTA_REDACT_PATHS=1 claude       # also redact path-like tokens on every surface this run
FICTA_LOG_LEVEL=trace claude      # verbose logs incl. raw bodies (debug only)
FICTA_SECRET_SHAPES_ENABLED=1 ficta claude # force secret-shape detection for this agent run
FICTA_PII_ENABLED=1 claude        # force PII detection for this one agent run
FICTA_PII_BACKEND=presidio FICTA_PII_ENABLED=1 ficta claude # use Presidio for this agent run
FICTA_DISABLE=1 claude            # bypass an installed shim once
ficta disable                     # bypass all shims until `ficta enable`
```

`FICTA_LOG_LEVEL` (`silent` < `error` < `warn` < `info` < `debug` < `trace`; default `info`
standalone, `silent` under a wrapped agent) is runtime-only by design and is **not** persisted to
`config.toml` — `trace` writes raw request/response bodies to disk, so it must be an explicit
per-run choice, never a saved default. Under wrapped agents, leave it unset/`silent` to keep TUIs
clean; set `info`/`debug`/`trace` only when you intentionally want proxy logs in the terminal.

## Commands

```sh
ficta setup        # configure registry sources and optional shims
ficta doctor       # check registry loading and agent routing
ficta install      # install transparent claude/codex/pi shims
ficta uninstall    # remove ficta-owned shims
ficta disable      # globally bypass installed shims without uninstalling
ficta enable       # re-enable installed shims globally
ficta claude       # launch an agent through ficta without shims
```

## Supported agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Anthropic base-URL routing. |
| Codex | Verified | API-key and ChatGPT/OAuth flows — see [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md). |
| Pi | Verified | Built-in `anthropic`/`openai`/`openai-codex` providers via ephemeral `PI_CODING_AGENT_DIR` + `models.json` base-URL override. |

Only CLI agents that route **all** model traffic through the proxy are supported. IDE clients such as
Cursor are not — their agentic features bypass a custom base URL. See the
[threat model](./docs/threat-model.md#ide-clients-cursor-etc).

## Documentation

- [`docs/install.md`](./docs/install.md) — ficta shim installation and runtime behavior
- [`docs/threat-model.md`](./docs/threat-model.md) — exact promise, covered surfaces, and non-goals
- [`docs/plugins.md`](./docs/plugins.md) — registry-source, detector, and agent-integration plugins
- [`docs/plugins.md#built-in-detector-plugin-pii`](./docs/plugins.md#built-in-detector-plugin-pii) — PII detector surfaces, backends, and failure policy
- [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md) — Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](./docs/benchmarks.md) — performance notes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md)

## Status

Ficta uses normal semver releases. Core exact-match redaction, restore, and fail-closed behavior is
covered by tests and local agent runs, but run `ficta doctor <agent>` before relying on a CLI setup.
Treat PII detection as best-effort and verify web-chat deployments with fake PII before sensitive use.

## License

MIT — see [`LICENSE`](./LICENSE).
