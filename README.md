![Ficta - a local secret airlock for coding agents](assets/ficta-overview.png)

# Ficta

[Website](https://ficta.sh)

Ficta is an open-source local redaction proxy for coding-agent model traffic. It sits between a
supported CLI agent and the model provider, replaces protected values with deterministic surrogates
before requests leave your machine, and restores the real values locally on the way back.

The strongest guarantee is exact-match protection for registered secrets you already manage in
`.env`, process env, or Doppler: if a registered value would be sent verbatim in a surface Ficta
redacts, Ficta blocks the request instead of forwarding it. Request-time secret-shape detection and
PII detection are opt-in, best-effort reduction layers; they are not completeness guarantees. The
exact boundary and deliberate exceptions are scoped in the
[threat model](packages/ficta/docs/threat-model.md).

Ficta is secret-hygiene and best-effort PII-reduction tooling. It is **not** enterprise DLP, a
compliance product, or a sandbox.

## Quick Start

```sh
npm install -g @serovaai/ficta
# or: pnpm add -g @serovaai/ficta  /  bun install --global @serovaai/ficta
```

```sh
ficta setup              # configure ~/.ficta/config.toml; optionally install shims
ficta doctor claude      # or: codex / pi
# restart your shell if setup installed shims
claude                   # now runs through Ficta
```

Without shims, launch explicitly:

```sh
ficta claude             # or: ficta codex / ficta pi
```

Full install and usage docs live in the package README:
**[`packages/ficta/README.md`](packages/ficta/README.md)**.

## What Ficta Protects

Ficta has three protection layers with different guarantees:

- **Registered secrets (strong exact match):** protects registered values in their verbatim form after
  registry filters and exclusions; redacts covered request bodies, query strings, and non-auth
  headers; fail-closes if a protected value survives redaction in a covered surface; and restores
  placeholders locally on model responses.
- **Detected secret shapes (best effort):** optionally detects known token/key formats at request
  time, including common API keys, JWTs, private keys, credential URLs, and secret-ish assignments
  such as `API_TOKEN=...`. This catches newly pasted values that were not in env/Doppler, but it is
  pattern-based and does not verify credentials.
- **Detected PII (best effort):** optionally detects PII at request time, tokenizes detected spans on
  egress, and restores them on response. The built-in backend covers high-precision regex detections
  for emails, US SSNs, and Luhn-valid card numbers; Microsoft Presidio is supported as a sidecar
  backend for broader NER-style detection.

By default, registered-secret discovery loads values from `.env` / `.env.local`, Doppler's current
config when the Doppler CLI is available, and secret-ish process env names such as `KEY`, `TOKEN`,
`SECRET`, `PASSWORD`, `AWS`, and `OPENAI`.

PII and secret-shape detector defaults are deliberately per surface: the standalone/web proxy follows
`[pii] enabled` and `[secret_shapes] enabled`, while launched coding agents keep those detector layers
off unless the matching `agents` toggle is true (`FICTA_PII_AGENTS` /
`FICTA_SECRET_SHAPES_AGENTS`) or the effective `FICTA_*_ENABLED` env var is explicitly set for that
one run.

### What It Does Not Protect

Ficta does not claim full prompt privacy, complete secret/PII discovery, or full DLP coverage. Out of
scope: unregistered values that do not match a known shape, transformed values
(base64/URL-encoded/split secrets), PII the detector misses, secrets or documents the agent sends
itself through tool execution / `curl` / MCP tools, binary responses, and arbitrary non-model network
egress. See the [threat model](packages/ficta/docs/threat-model.md) for the full boundary.

## Supported Agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Uses Anthropic base URL routing. |
| Codex | Verified | Supports API-key and ChatGPT/OAuth flows. |
| Pi | Verified | Routes built-in `anthropic`/`openai`/`openai-codex` providers via an ephemeral `PI_CODING_AGENT_DIR` + `models.json` base-URL override. |

Ficta only supports CLI agents that route **all** of their model traffic through its proxy. **IDE
clients such as Cursor are not supported** - their agentic features bypass a custom base URL, so
secrets could reach the provider unredacted. See the
[threat model](packages/ficta/docs/threat-model.md#ide-clients-cursor-etc).

## Ficta Gateway

**[`apps/gateway`](apps/gateway)** contains Ficta Gateway: a self-hosted private chat gateway for
regulated or internal teams that want sensitive-data-aware model access. Gateway runs inside the
operator's environment, keeps OpenAI/Anthropic API keys server-side, and points every model call at
the same Ficta proxy so registered values and enabled detector spans are tokenized before the vendor
hop and restored locally in the streamed response.

Gateway is a separate product path from the coding-agent CLI. Its operator guide, local POC setup,
auth/storage guidance, sidecar notes, and production-like deployment cautions live in
**[`apps/gateway/README.md`](apps/gateway/README.md)**.

## What's In This Repo

This is a monorepo. The main published package is the Ficta CLI/proxy; Gateway is the self-hosted
private chat surface built on the same redaction engine.

- **[`packages/ficta`](packages/ficta)** - [`@serovaai/ficta`](https://www.npmjs.com/package/@serovaai/ficta),
  the MIT-licensed CLI, redaction proxy, registry sources, agent integrations, detector backends, and
  plugin seams. This is the package published to npm.
- **[`packages/protocol`](packages/protocol)** - [`@serovaai/ficta-protocol`](https://www.npmjs.com/package/@serovaai/ficta-protocol),
  the dependency-free wire contract package shared by the proxy and Gateway control-plane calls.
- **[`apps/gateway`](apps/gateway)** - Ficta Gateway, a self-hosted TanStack Start chat UI with
  server-side BYO OpenAI/Anthropic keys, chat history/settings storage, optional WorkOS
  auth/workspaces, protection-status polling, and text/document attachments.
- **[`apps/web`](apps/web)** - the public website for Ficta and Ficta Gateway.

## Documentation

- [`packages/ficta/README.md`](packages/ficta/README.md) - full CLI/proxy install, usage, and commands
- [`apps/gateway/README.md`](apps/gateway/README.md) - Ficta Gateway setup, POC defaults, and deployment cautions
- [`docs/install.md`](packages/ficta/docs/install.md) - Ficta shim installation and runtime behavior
- [`docs/threat-model.md`](packages/ficta/docs/threat-model.md) - exact promise, covered surfaces, and non-goals
- [`docs/plugins.md`](packages/ficta/docs/plugins.md) - registry-source, detector, and agent-integration plugins
- [`docs/plugins.md#built-in-detector-plugin-secret-shapes`](packages/ficta/docs/plugins.md#built-in-detector-plugin-secret-shapes) - request-time secret-shape detector surfaces and limits
- [`docs/plugins.md#built-in-detector-plugin-pii`](packages/ficta/docs/plugins.md#built-in-detector-plugin-pii) - PII detector surfaces, backends, and failure policy
- [`docs/codex-oauth-intercept.md`](packages/ficta/docs/codex-oauth-intercept.md) - Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](packages/ficta/docs/benchmarks.md) - performance notes
- [`CONTRIBUTING.md`](packages/ficta/CONTRIBUTING.md) - contributing to core and extension seams
- [`SECURITY.md`](packages/ficta/SECURITY.md) - reporting vulnerabilities and expected limitations

## Status

Ficta uses normal semver releases. Core exact-match redaction, restore, and fail-closed behavior is
covered by tests and local agent runs, but CLI users should run `ficta doctor <agent>` before relying
on a setup. Treat detector layers as best effort, and verify any Gateway deployment with fake PII and
fake secret-shaped tokens before sensitive workflows.

## Development

```sh
pnpm install
pnpm dev             # proxy + Gateway; auto-uses Doppler when configured, otherwise local .env
pnpm dev:proxy       # proxy only
pnpm gateway:dev     # Gateway only
pnpm check           # biome
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` is for developing the proxy and Gateway together. The coding agents do not use it -
`ficta claude|codex|pi` starts its own ephemeral proxy per launch (see
[`docs/install.md`](packages/ficta/docs/install.md)).

## License

This monorepo is dual-licensed by product - see [`LICENSING.md`](LICENSING.md) for the map:

- **`packages/ficta`** (the published `@serovaai/ficta` engine + CLI) - **MIT**, see [`packages/ficta/LICENSE`](packages/ficta/LICENSE).
- **`apps/gateway`** (Ficta Gateway) - **AGPL-3.0-only**, with a commercial license available; see [`apps/gateway/LICENSING.md`](apps/gateway/LICENSING.md).
