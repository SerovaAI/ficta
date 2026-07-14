# Plugins and registry-source discovery

ficta separates the privacy-critical core from the places values come from.

The core invariant is:

> Plugins may own source-specific **config/setup metadata**, but at runtime they only **report
> values or detections**. The core engine/vault performs replacement, fail-closed leak checks, and restore.

That lets us add sources like Doppler/1Password or detectors like Gitleaks without letting plugin
code bypass the redaction boundary.

## Terminology

- **Plugin** — the umbrella term for a narrow extension point inside ficta. A plugin must explicitly
  declare a capability boundary; registry hooks are valid only on `kind: "registry-source"` plugins
  that also own their source-specific metadata.
- **Registry-source plugin** — loads exact protected values at launch, such as managed registry
  files, `.env`, process env, Doppler, or a future secret-manager source. This is the strongest
  exact-match layer.
- **Detector plugin** — inspects request text at runtime and reports values to protect. A PII
  integration should be described as a **PII detector plugin**. Detector coverage is best effort and
  secondary to registry-source exact matching.
- **Agent-integration plugin** — teaches ficta how to launch a coding agent through the local proxy,
  such as Claude Code, Codex, or Pi.
- **Registry policy contribution** — optional, safe metadata-only rules declared by the plugin that
  owns a domain. These rules can exclude exact identifiers such as env var names from protection;
  they never contain raw values or arbitrary code. Excluding a name is *un-protection* — the inverse
  of the normal add-only contract — so core only enforces rules declared by trusted built-in
  plugins, and applies them wherever a named candidate enters protection (registry load and
  request-time detection alike). Rules from untrusted plugins are reported but not enforced.
  Alongside these plugin-declared rules, core synthesizes one trusted rule (plugin label
  `user-config`) from the user's own `registry.exclude_names` / `FICTA_REGISTRY_EXCLUDE_NAMES` list —
  the local user is trusted like a built-in. It is prepended to the effective policy so an overlapping
  name attributes to the user, and `ficta review` is the interactive editor for it (see below). The
  review only ever toggles the user's own list; it never duplicates or overrides a plugin-declared
  rule (plugin-excluded names are shown but not selectable).
- **Provider adapter** — provider/wire-format routing and restore support. This is core-owned for
  now; new provider support should be discussed before a large PR.
- **Addon** — a future packaging term for optional external code that may contain one or more
  plugins. ficta does not yet have a stable external addon API or automatic third-party plugin
  loading.

## Plugin types

Today a plugin can provide any of these capabilities:

1. **Registry source** — launch-time exact values. This is the exact-match layer: if a value is loaded
   here, ficta exact-matches it and fail-closes if it would reach the model verbatim in a covered
   request surface. Filesystem-path-like tokens are skipped by default; set `FICTA_REDACT_PATHS=1`
   to redact inside paths too.
2. **Detector** — request-time detections. This is the best-effort layer for unknown/pasted secrets
   or optional PII-like patterns; it is not the primary product promise.
3. **Agent integration** — how to launch a client through the ephemeral ficta proxy (`claude`,
   `codex`, `pi`, later `opencode`, etc.).

The TypeScript shape makes the registry boundary explicit:

```ts
type FictaPlugin = RegistrySourcePlugin | DetectorPlugin | AgentIntegrationPlugin;

interface RegistrySourcePlugin {
  kind: "registry-source";
  name: string;

  // Required: each registry source owns its TOML/env/default metadata and setup UX.
  config: RegistryPluginConfig;
  setup: RegistryPluginSetup;

  // Required: values and safe status only; never print protected values.
  discover(): readonly PluginDiscovery[];
  loadValues(): readonly ProtectedValue[];
}
```

A plugin that defines registry hooks (`loadValues`, `discover`, `config`, or `setup`) without
`kind: "registry-source"` and the required registry metadata fails validation. `ProtectedValue.value`
is the protected literal and must never be logged. `PluginDiscovery` is the safe thing the CLI may
print. Built-in `RegistryPluginConfig` / `RegistryPluginSetup` metadata lets each registry source
own its TOML/env bindings and setup prompts. `AgentIntegration` returns a launch plan; the CLI still
owns shim resolution, proxy lifecycle, and cleanup.

`loadValues()` returns *candidates*, not the final protected set: core (`loadPluginRegistry` /
`ProtectionEngine`) applies trusted registry-policy exclusions and the vault dedupes before anything
is protected. A source's discovery count is therefore a candidate count and can exceed the protected
total — the startup banner reconciles the difference (see "Launch-time discovery UX").

## Launch-time discovery UX

`ficta claude` / `ficta codex` / `ficta pi` starts by building a registry snapshot. To avoid
corrupting full-screen agent TUIs, interactive launches do not print startup diagnostics by default.
When stderr is redirected/piped (scripts, logs), or when you explicitly ask with `--ficta-verbose`,
the compact output is:

```txt
🔒 ficta ready — 47 protected values (48 loaded before dedupe)
   pi → http://127.0.0.1:59717
   sources: Doppler 34, managed registry 12, .env.local 4, process env 10
   secret shapes: off
   pii: off
```

Pass `--ficta-verbose` after the agent command (or set `FICTA_LOG_LEVEL=debug`) to show diagnostics
in an interactive terminal and include the full safe discovery report. Request-time proxy logs are
controlled only by `FICTA_LOG_LEVEL`: wrapped agents default it to `silent`, while explicit
`info`/`debug`/`trace` prints proxy logs to stderr for debugging.

```txt
source details:
  ✓ Doppler CLI (34 values) — loaded current config via `doppler secrets download --no-file --format json`; skipped 4 shorter than 8 chars
      current: 34 loaded
  ✓ managed registry files (12 values) — read 1 file(s)
      .data/protected-registry.json: 12 loaded
  ✓ env files (4 values) — read 1 file(s)
      .env: not found
      .env.local: 4 loaded
  ✓ process env (10 values) — enabled for secret-ish env names; skipped 4 shorter than 8 chars, 3 empty
```

When diagnostics are shown and nothing is loaded, the compact summary says so and the existing
passthrough/strict-mode warning explains what happens next. Run `ficta doctor` when you want the full
source report without launching an agent.

The source report is safe to print: counts + file/source names only, never values. Raw body logs
remain an explicit debugging opt-in only.

## Configuring built-in plugins

Persistent user config lives in `~/.ficta/config.toml` (written by `ficta setup`). Shell
`FICTA_*` environment variables still override the TOML for a single run, but normal plugin/source
configuration should live in TOML:

```toml
[registry]
min_len = 8
require = false

[registry.env_file]
enabled = true
paths = [".env", ".env.local"]

[registry.managed_file]
enabled = true
paths = [".data/protected-registry.json"]

[registry.process_env]
enabled = true
mode = "secret-ish"

[registry.doppler]
enabled = true
configs = "current" # or "all" / ["dev", "staging", "prod"]
project = ""
# command = "doppler"
timeout_ms = 5000

[secret_shapes]
enabled = false # set true to redact known token/key shapes before the model
agents = false  # coding-agent launches — opt in with true

[pii]
enabled = false # set true to redact emails, SSNs, and card numbers before the model
agents = false
```

Set `FICTA_CONFIG_FILE=/path/to/config.toml` to use a different config file; `ficta setup` writes
to that same path. Set `FICTA_CONFIG_FILE=0` to disable user config loading; setup will then refuse
to run until you unset it or provide a real path.

## Built-in detector plugin: `secret-shapes`

The `secret-shapes` detector catches newly pasted secret-shaped values that were not present in the
launch-time registry. It is local and in-process: no network verification, no sidecar, and no
entropy-only scanning. The initial detector set focuses on high-signal shapes: common API key
prefixes, JWTs, PEM private keys, credential URLs with userinfo, AWS access key IDs and secret
assignments such as `API_TOKEN=...`.

This layer is **best effort**. It complements, but does not replace, registry exact matching: a value
loaded from a managed registry file, `.env`, process env, or Doppler gets the stronger
exact-match/fail-closed invariant, while a newly pasted value is protected only if it matches one of
the known shapes.

Like PII, it has separate web/standalone and agent-launch posture:

```toml
[secret_shapes]
enabled = true   # web / standalone proxy
agents = false   # coding-agent launches — opt in with true
```

An unconfigured proxy is off (`FICTA_SECRET_SHAPES_ENABLED=0` by default). `ficta setup` defaults the
web/standalone toggle to **yes**, because this is the chat use case where users paste ad hoc keys.
Launched coding agents stay off unless both `[secret_shapes] enabled` and `[secret_shapes] agents` are true,
because codebases often contain examples and test fixtures with token-shaped strings. For a single
agent run, an explicit shell `FICTA_SECRET_SHAPES_ENABLED=1` or `0` wins over TOML.

## Built-in detector plugin: `pii`

Unlike the registry sources below — which load *exact* secrets to protect — the PII plugin is a
**detector**: it inspects request text at runtime and redacts PII before the model hop, restoring it
in the response. Detection is a *concept* backed by a registry of pluggable **backends**, of which
one or more can run at a time: the in-process `regex` backend (emails, US SSNs, Luhn-validated
cards) is the always-available default, an out-of-process Microsoft Presidio sidecar (`presidio`)
covers general/rule-based PII, and an external OpenMed analyzer service (`medical`) covers learned
medical/PHI-style spans. Backend selection is config-driven (see [Choosing backends](#choosing-backends)
below). Coverage is best-effort, not a guarantee; see [`threat-model.md`](./threat-model.md).

**Two surfaces, and their defaults differ on purpose.** PII posture is scoped to *where the request
came from*, because tokenizing an email inside code you're editing is rarely what you want, while
redacting it in a web-chat message usually is:

- **Web / standalone proxy** — governed by `[pii] enabled` (`FICTA_PII_ENABLED`). An unconfigured
  proxy is **off** (`envDefaults: { FICTA_PII_ENABLED: "0" }`) — a raw `ficta` run protects only
  *registered* secrets. After `ficta setup` it is **on**: the wizard's first PII prompt defaults to
  **yes** and persists `[pii] enabled = true`, because for the web UI, PII detection is a first-class
  part of the gateway.
- **Launched coding agents** (`ficta claude|codex|pi`) — **off by default even when `[pii] enabled`
  is on.** Re-enable them explicitly with `[pii] agents = true` (`FICTA_PII_AGENTS`). The setup
  wizard asks this as a second, default-**no** prompt (only when the proxy toggle is on, since
  `agents` is a no-op without `enabled`).

The persisted policy lives in TOML:

```toml
[pii]
enabled = true   # web / standalone proxy
agents = false   # coding-agent launches — opt in with true
```

### Identity protection boundary

The shipped Presidio sidecar protects structured identity/contact/account values plus
context-qualified people, organizations, company registration numbers, birth dates, and personal
addresses. Organization aliases require an organization accepted in the same document; cue-scoped
OCR spacing is handled without globally registering a bare company-name stem.

It deliberately keeps amounts, rates, percentages, contract durations, notice and cure periods,
court names, jurisdictions, nationality labels, and ordinary business dates visible.
Those terms often carry the reasoning the model needs and are not identifying without attribution.
Use the exact registry or Gateway's pre-send selection for commercially confidential values such as
deal amounts, project codes, or clauses.

This behavior belongs to the reference Presidio deployment, not a Ficta engine profile. If you point
Ficta at another Presidio-compatible analyzer, that analyzer owns its recognizers and candidate
policy; Ficta applies its configured entity allowlist, minimum-length safeguard, and tokenization but
does not reinterpret raw PERSON/ORGANIZATION results.

**Precedence for a coding-agent launch**, highest first: (1) an explicit shell `FICTA_PII_ENABLED`
wins either way — the "flip it for a single run" escape hatch (`FICTA_PII_ENABLED=1 ficta claude`
turns it on for that run; `=0` forces it off); (2) otherwise PII is on for the agent iff **both**
`[pii] enabled` and `[pii] agents` are true. So `enabled = false` is a single kill switch across both
surfaces, and `agents = true` alone does nothing.

Mechanically, the `ficta <agent>` launcher resolves this to a single effective `FICTA_PII_ENABLED`
before the proxy loads, so the engine, the startup banner's `pii:` line, and `ficta doctor` all read
one flag. The standalone proxy (`startProxy()` on `FICTA_PORT`, which the web UI calls) reads `[pii]
enabled` directly and ignores `[pii] agents`.

### Choosing backends

PII detection can run multiple backends, selected by name via `FICTA_PII_BACKENDS` ↔ `[pii] backends`.
The deprecated single-backend setting, `FICTA_PII_BACKEND` ↔ `[pii] backend`, remains readable when
`backends` is unset so existing installations keep working; new setup and examples use only the
list form. Enabling PII never silently reaches for a sidecar — you opt into networked
backends explicitly:

```toml
[pii]
enabled = true
backends = ["presidio", "openmed"] # or ["regex"], ["presidio"], etc.
```

Equivalently `FICTA_PII_BACKENDS=presidio,openmed`. `ficta setup` prompts for the backend set and
URLs for selected sidecars. Unknown names are skipped and reported by `ficta doctor` and the startup
banner; if all configured names are unknown, Ficta falls back to `regex`.

Ficta always runs its local structured regex recognizer, then calls each selected network recognizer,
deduplicates exact matches, and resolves substring overlaps by confidence, medical specificity, then longer value. For
medical workflows, prefer `["presidio", "openmed"]`: Presidio remains stronger for deterministic and
custom general PII, while OpenMed adds medical/PHI-style learned detection.

### The `presidio` backend

ficta calls [`presidio-analyzer`](https://microsoft.github.io/presidio/) at the configured URL. Two
managed ways to run it build `packages/ficta/presidio/Dockerfile` and mount
`packages/ficta/presidio/default_recognizers.za.yaml` plus `nlp_engine.za.yaml`. The image is pinned to
a known Presidio base and registers `FictaSpacyIdentityRecognizer`: raw spaCy NER remains internal to
Presidio, while contextual admission, international registration numbers, aliases, transaction-table
organizations, and cue-scoped OCR fields are returned as final candidates. General date recognition
is disabled; birth-date recognition is context-bound. The registry retains structured recognizers
such as South African IDs, document identifiers, and Mauritius phones.

- **`pnpm sidecars`** (repo root, ↔ `docker-compose.sidecars.yml`) starts the shared sidecar stack
  detached with health-gated `--wait` and `--build`: the Gateway document converter plus both PII sidecars.
  `pnpm sidecars:down` stops them. This is the way to run them outside the dev wrapper — a server, a
  teammate's machine, a POC box. After pulling recognizer code or Presidio configuration changes,
  rerun `pnpm sidecars` so the local `ficta-presidio:dev` image is rebuilt and the analyzer is
  recreated; a plain Compose `up` can reuse the stale local image.
- **Root `pnpm dev`** auto-manages the sidecars for whichever backends `FICTA_PII_BACKENDS`
  selects (force per-sidecar with `FICTA_PII_PRESIDIO_MANAGED` /
  `FICTA_PII_OPENMED_MANAGED`). It reuses anything already healthy at the configured URL — including
  compose-started containers — and tears down only what it started.

ficta calls `POST {url}/analyze` for each request **body** (header/query surfaces stay regex-based,
to avoid one request fanning out into many sidecar calls). To run the container by hand instead:

```sh
docker build -t ficta-presidio packages/ficta/presidio
docker run -d --name presidio-analyzer -p 5002:3000 \
  -v "$PWD/packages/ficta/presidio/default_recognizers.za.yaml:/app/ficta-presidio-recognizers.yaml:ro" \
  -v "$PWD/packages/ficta/presidio/nlp_engine.za.yaml:/app/ficta-nlp-engine.yaml:ro" \
  -e RECOGNIZER_REGISTRY_CONF_FILE=/app/ficta-presidio-recognizers.yaml \
  -e NLP_CONF_FILE=/app/ficta-nlp-engine.yaml \
  ficta-presidio
curl http://127.0.0.1:5002/health   # {"status":"..."} once ready
```

After changing or deploying the recognizer/NLP configuration, run the fully synthetic legal-identity
regression against the live sidecar. It verifies people, organizations and aliases, IDs, contact details and
international registrations while asserting that amounts, rates, dates, jurisdictions and timing
terms remain model-visible, with zero known survivors and exact restoration:

```sh
pnpm --filter @serovaai/ficta check:presidio
```

Config (`[pii.presidio]` ↔ `FICTA_PII_PRESIDIO_*`):

| TOML key | env | default | meaning |
| --- | --- | --- | --- |
| `url` | `FICTA_PII_PRESIDIO_URL` | `http://127.0.0.1:5002` | analyzer base URL |
| `language` | `FICTA_PII_PRESIDIO_LANGUAGE` | `en` | analyzer language |
| `score_threshold` | `FICTA_PII_PRESIDIO_SCORE_THRESHOLD` | `0.5` | drop spans below this score |
| `entities` | `FICTA_PII_PRESIDIO_ENTITIES` | *(all)* | entity allowlist |
| `timeout_ms` | `FICTA_PII_PRESIDIO_TIMEOUT_MS` | `1500` | total detection budget per request |

(The fail-open/fail-closed behavior when Presidio is unreachable is `[pii] fail_closed`, covered in
[Failure policy](#failure-policy--core-enforced-global-default--per-detector-override) below.)

A detected value replaces **every** eligible occurrence of that string in the body. The Presidio
entity allowlist remains the final category gate. For coding-agent traffic, use an allowlist tuned to
the workload rather than every available structured recognizer — e.g.
`entities = ["PERSON", "PHONE_NUMBER", "LOCATION", "EMAIL_ADDRESS"]`. Legal-document deployments
should also include `DOCUMENT_ID`, `COMPANY_REGISTRATION`, and `DATE_TIME`; leaving `entities = []`
enables every configured recognizer. Values shorter than 4 chars are dropped regardless, to avoid
shredding normal prose.

GLiNER is an evaluation option inside the same Presidio image, not a Ficta backend or default. In a
source checkout, build with `--build-arg INSTALL_GLINER=1`, run it with
`FICTA_PRESIDIO_NER=gliner`, and compare analyzer URLs using
`pnpm --filter @serovaai/ficta bench:pii-ner -- --spacy-url=... --gliner-url=...`. The
checked-in legal corpus recommends GLiNER only when it improves both identity recall and legal-text
precision by at least two percentage points; the current corpus keeps spaCy.

### The `openmed` backend

For medical workspaces, run the upstream [OpenMed](https://github.com/maziyarpanahi/openmed) REST
service **alongside** Presidio — unmodified, the same operational model as Presidio — and select it
as the `openmed` backend. It speaks OpenMed's own strict API: Ficta calls `POST {url}/pii/extract` for each request **body**
(header/query surfaces stay regex-based) and probes `GET /health`. Detection only — Ficta owns
tokenize/restore; OpenMed's de-identification endpoints are not used.

Upstream publishes a multi-arch service image at `ghcr.io/maziyarpanahi/openmed` (amd64 + arm64,
cosign-signed), pulled automatically like the Presidio image — `pnpm sidecars` runs it (with
Presidio) via `docker-compose.sidecars.yml`, and root `pnpm dev` auto-manages it when the backend
set includes `openmed` (force with `FICTA_PII_OPENMED_MANAGED`; pin a tag or substitute a locally
built patched image via `FICTA_PII_OPENMED_IMAGE`). The HuggingFace cache lives in the
`openmed-hf-cache` Docker volume, so only the first start on a machine pulls the image and downloads
the model (startup budget `FICTA_PII_OPENMED_STARTUP_TIMEOUT_MS`, default 300000).

To run the container by hand instead (serves on 8080):

```sh
docker run --rm -p 5004:8080 \
  -e OPENMED_SERVICE_PRELOAD_MODELS=OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1 \
  -e OPENMED_SERVICE_KEEP_ALIVE=10m \
  -e OPENMED_TORCH_ATTENTION_BACKEND=eager \
  -v openmed-hf-cache:/root/.cache/huggingface \
  ghcr.io/maziyarpanahi/openmed:latest
curl http://127.0.0.1:5004/health   # ok once ready
```

(`OPENMED_TORCH_ATTENTION_BACKEND=eager` is required for the default DeBERTa-based PII models on the
CPU image — its transformers/torch combination rejects the SDPA attention path for that architecture.)

Then point Ficta at it:

```sh
FICTA_PII_ENABLED=1 \
FICTA_PII_BACKENDS=presidio,openmed \
ficta claude
```

Config (`[pii.openmed]` ↔ `FICTA_PII_OPENMED_*`):

| TOML key | env | default | meaning |
| --- | --- | --- | --- |
| `url` | `FICTA_PII_OPENMED_URL` | `http://127.0.0.1:5004` | service base URL |
| `model` | `FICTA_PII_OPENMED_MODEL` | *(server default)* | model repo id sent as `model_name` |
| `lang` | `FICTA_PII_OPENMED_LANG` | `en` | PII language |
| `score_threshold` | `FICTA_PII_OPENMED_SCORE_THRESHOLD` | `0.5` | drop entities below this confidence |
| `entities` | `FICTA_PII_OPENMED_ENTITIES` | *(all)* | canonical-label allowlist, applied client-side |
| `timeout_ms` | `FICTA_PII_OPENMED_TIMEOUT_MS` | `2500` | total detection budget per request |

Transformer inference is slower than Presidio's rule engine — preload the model
(`OPENMED_SERVICE_PRELOAD_MODELS`) so a cold start doesn't consume the request budget. OpenMed
detections merge with the other backends' results and win overlap ties (medical specificity). The
same caveat applies: best-effort PII/PHI reduction, not a HIPAA
de-identification guarantee.

### Failure policy — core-enforced, global default + per-detector override

When a selected backend cannot run — e.g. a sidecar is down or slow past `timeout_ms` — the detector
records the outage and applies the configured failure policy. In fail-open mode, the failed backend is
skipped while reachable selected backends still run. In fail-closed mode, the request is blocked.

The decision resolves **per-detector override, else global default**:

| Setting | Scope | Default | Effect when a detector backend is unreachable |
| --- | --- | --- | --- |
| `[detection] fail_closed` / `FICTA_FAIL_CLOSED_DETECTION` | all detectors | `false` | global default: fail-open (skip) unless a detector overrides |
| `[pii] fail_closed` / `FICTA_PII_FAIL_CLOSED` | the `pii` detector | *(unset → defers to global)* | override: `true` blocks, `false` forces fail-open, unset defers |

- **Fail-open** — skip the failed backend for that request (one-time warning) and forward with any
  other reachable backend detections. Best-effort; PII covered only by the failed backend may reach
  the model unredacted while it is down.
- **Fail-closed** — block the request with a `503 ficta_blocked` response; nothing reaches the model
  until every selected backend is reachable.

Best-effort deployments keep the defaults; compliance deployments that must never send unscreened data
set `[pii] fail_closed = true` (or the global `[detection] fail_closed = true`) and run the sidecar
under a supervisor. `ficta setup` prompts for the per-PII override when Presidio is the chosen backend.

This is **core-enforced**: a detector plugin exposes its `failClosed()` config but never blocks the
request itself — the engine resolves the policy and the transport returns the 503. It is also
**independent of the global `FICTA_FAIL_CLOSED`**, which blocks only when a *registered exact secret*
would leak (a different condition, default on) — unaffected by a detector's availability. `ficta
doctor` probes `/health` and, when `presidio` is selected but unreachable, warns whether requests are
being skipped or blocked given the resolved policy.

## Built-in registry source: `doppler-cli`

The Doppler CLI plugin runs before the agent launches and attempts to load exact values with:

```sh
doppler secrets download --no-file --format json --no-fallback --silent
```

Default TOML:

```toml
[registry.doppler]
enabled = true
configs = "current"
```

Disable it with:

```toml
[registry.doppler]
enabled = false
```

By default only Doppler's active config for the current repo/scope is loaded. To cover agents that
may call other configs, set:

```toml
[registry.doppler]
configs = ["dev", "staging", "prod"]
# or:
# configs = "all"
project = "my-project" # optional explicit project
```

The command output is parsed in memory, filtered by `registry.min_len`, and never printed.
Discovery output contains only counts/status/config names. The startup timeout defaults to 5 seconds
and can be changed with `registry.doppler.timeout_ms`.

`registry.doppler.command` / `FICTA_REGISTRY_DOPPLER_COMMAND` is trusted local config: ficta
executes that command directly (without a shell), refuses project-local or world-writable resolved
commands, and passes a minimal Doppler/HOME/proxy environment so the real Doppler CLI can
authenticate. Only point it at a trusted executable you control; do not accept this setting from
untrusted project files or shell snippets.

This is the source that protects values if the agent later runs `doppler ...`: the secrets are
already registered before the model session starts. Loading `all` configs is explicit so a dev
session does not silently pull prod secrets into RAM unless you ask for that coverage.

The Doppler plugin also declares a registry-policy exclusion for Doppler-owned metadata env names:
`DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`, and `DOPPLER_PROJECT`. Because Doppler is a trusted built-in,
core enforces that exclusion wherever a candidate by one of those names would enter protection, so
the process-env source will not surrogate local routing/config labels. The exclusion is a precise
negative override on top of the secret-ish heuristic — those names still match the heuristic, they
are just dropped afterward. Credential variables such as `DOPPLER_TOKEN` are not on the exclusion
list and remain protected by the normal `TOKEN` heuristic.

## Built-in registry source: `managed-registry-file`

This plugin loads exact admin-approved business values from JSON files. It is separate from
`known-env-values`: env sources protect runtime/config material such as API keys and database URLs,
while managed registry files protect domain values such as client names, matter IDs, patient IDs,
account numbers, project names, and aliases. Both sources feed the same `ProtectedValue[]` contract
and therefore use the same vault, exact-match redaction, fail-closed leak checks, and restore path.

Default TOML:

```toml
[registry.managed_file]
enabled = true
paths = [".data/protected-registry.json"]
```

Add extra files, point at Gateway's exported file, or disable the source:

```toml
[registry.managed_file]
enabled = true
paths = ["/absolute/path/from/gateway/protected-registry.json"]

# or:
# enabled = false
```

Canonical file shape:

```json
{
  "schema": "ficta.managed-registry.v1",
  "revision": "8fe0f1e0-4e6c-4627-afcb-4628993ad0af",
  "generatedBy": "ficta-gateway",
  "generatedAt": "2026-07-10T10:00:00.000Z",
  "entries": [
    {
      "id": "entry-1",
      "name": "gateway:client:nsb-2026-0147:entry-1",
      "type": "client",
      "scope": "NSB-2026-0147",
      "value": "Northstar Biologics (Pty) Ltd",
      "aliases": ["Northstar"],
      "kind": "custom"
    }
  ]
}
```

The proxy validates this versioned shape strictly and rejects missing fields or unknown schema versions.
`name` is a safe label for logs and discovery metadata; it must not contain the protected value.
`value` and `aliases` are filtered by `registry.min_len`, deduped, loaded into memory, and never
printed. `revision` is a required non-sensitive generation identifier: Gateway changes it on every
atomic publication and sends it to `POST /__ficta/registry/reload`, allowing the proxy to acknowledge
that exact file generation rather than treating an ambiguous `added: 0` as success. Discovery output
reports only file paths, statuses, and counts.

## Built-in registry source: `known-env-values`

This plugin exposes two discovered sources:

### Env files

Default TOML:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.local"]
```

Add extra files, or disable the source:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.production", "config/secrets.env"]

# or:
# enabled = false
```

### Process env

By default, the wrapper loads process-env values whose names look secret-ish. This protects common
agent behavior like running `env` or printing tool output that includes inherited API keys. Disable
it only if the extra exact-match values cause unacceptable false positives:

```toml
[registry.process_env]
enabled = true
mode = "secret-ish" # or "all"

# or:
# enabled = false
```

Secret-ish names are matched by a conservative name filter such as `KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `JWT`, `DATABASE`, `OPENAI`, `ANTHROPIC`, `AWS`, `GITHUB`, `DOPPLER`, and similar.
Trusted provider-owned metadata exclusions from registry-policy contributions are then applied as a
negative override, dropping precise non-secret names the heuristic matched. Proxy-internal values
that child agents do not need, such as `FICTA_SURROGATE_KEY`, are not passed to the child agent
process.

### Reviewing what gets redacted (`ficta review`)

The default posture is to redact every discovered value; deciding what *not* to redact is a
per-name opt-out, not a length heuristic. `ficta review` (also offered as a step in `ficta setup`)
loads the registry and shows the discovered names — grouped by source, never the values. Each name is
pre-selected as "protect" *unless* a heuristic classifier flags it as likely non-secret, in which
case it starts unchecked with a reason hint (e.g. "probably not a secret — looks like a URL (no
credentials)"). The classifier reads the discovered value(s) once, in memory only, to decide — a
credential-shaped or high-entropy value is always kept protected (so `DATABASE_URL` with an embedded
password stays checked), while credential-free URLs, filesystem/socket paths, booleans/enums, and
well-known config names (`AWS_PROFILE`, `LOG_LEVEL`, `*_PROMPT_*`, …) default to unchecked. The
verdict is a fixed label; no value text is ever stored on a candidate, rendered, or hinted. This only
changes the prompt's *default* selection — nothing is persisted until you submit, which is your
confirmation. Deselecting a name writes it to `registry.exclude_names` /
`FICTA_REGISTRY_EXCLUDE_NAMES`; re-selecting a previously-excluded name removes it. Excluded names
are enforced at both the registry-load and request-time-detection seams and are listed in the
startup banner and `ficta doctor`. The older `registry.min_len` filter still applies as a silent
default of 8 (short values overmatch normal text) but is no longer a setup prompt.

## Optional detector plugins

Detector plugins run during request redaction. They are useful for high-confidence unknown secrets
or PII-like values, but they are best-effort and should not be the headline claim:

```ts
const emailDetector: FictaPlugin = {
  name: "email-detector",
  detectText(text) {
    return [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map((value) => ({
      name: "EMAIL",
      value,
      source: "email-detector",
      kind: "pii",
      confidence: "high",
    }));
  },
};
```

Detector output enters the same vault as registry values, but the protection claim is different:

- registry exact values: **covered by the exact-match fail-closed invariant in covered request surfaces**
- detector values: **best effort, depending on detector coverage/precision**

## Built-in agent integrations

The `builtin-agent-integrations` plugin currently provides:

- `claude` — launches the real Claude Code executable with `ANTHROPIC_BASE_URL=<ficta>`.
- `codex` — launches the real Codex executable with temporary `-c` provider overrides; detects
  ChatGPT/OAuth auth and adds `requires_openai_auth` + `chatgpt_base_url` when needed.
- `pi` — launches Pi with `PI_CODING_AGENT_DIR` pointed at an ephemeral agent dir that symlinks the
  user's real `auth.json`/`settings.json`/`trust.json`/sessions and swaps in a generated `models.json`
  whose `providers` override the base URLs of the built-in `anthropic` (`<ficta>`), `openai`
  (`<ficta>/v1`), and `openai-codex` (`<ficta>/backend-api`) providers. A `models.json` provider base
  URL is the only override Pi reliably honors — its extension `registerProvider({ baseUrl })` patches
  model copies after load and never reaches the request layer. User-defined providers are preserved
  untouched; since they point at their own upstreams, ficta cannot route them.

Shim installation is derived from the registered agent integrations, not a hardcoded command list.

## Safety rules for plugins

- Never log or print `ProtectedValue.value`.
- `discover()` output must be safe metadata only.
- Keep secret-manager calls launch-time; request-time plugins should be local and fast.
- Use timeouts for external CLI integrations.
- The request path should only add values/detections; the core remains responsible for redaction,
  leak counting, and restore.

External/community plugins should be explicit opt-in later. Built-ins are trusted and loaded by
default.
