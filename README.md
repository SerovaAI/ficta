<p align="center">
  <a href="https://ficta.sh">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/ficta-lockup.svg">
      <img src="assets/brand/ficta-lockup-on-light.svg" alt="ficta" width="240">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Your coding agent reads your <code>.env</code>. Ficta keeps those keys off the provider's servers.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@serovaai/ficta"><img src="https://img.shields.io/npm/v/@serovaai/ficta?color=F1552F&label=npm" alt="npm version"></a>
  <a href="packages/ficta/LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1552F" alt="MIT license"></a>
  <a href="packages/ficta/docs/threat-model.md"><img src="https://img.shields.io/badge/threat%20model-published-F1552F" alt="Threat model"></a>
</p>

<p align="center">
  <a href="https://ficta.sh">Website</a> ·
  <a href="packages/ficta/README.md">Docs</a> ·
  <a href="packages/ficta/docs/threat-model.md">Threat model</a> ·
  <a href="apps/gateway/README.md">Gateway for teams</a>
</p>

---

Coding agents read your files, run your commands, and send everything they see to a model provider —
API keys, tokens, database URLs, customer emails. **Ficta** is a local proxy that sits between the
agent and the provider. It swaps sensitive values for placeholders before a request leaves your
machine, and swaps the real values back when the response arrives. The agent keeps working normally;
the provider never receives the real values.

Open source (MIT), runs locally per launch, no account, no telemetry.

## What the provider sees

The agent runs `cat .env` and sends the output to the model. Without Ficta, the provider gets:

```text
API_TOKEN=tok_9f8e7d6c5b4a39281706f5e4d3c2
DATABASE_URL=postgres://admin:hunter2-prod@db.internal:5432/app
```

With Ficta, the same request reaches the provider as:

```text
API_TOKEN=FICTA_<32 hex chars>
DATABASE_URL=FICTA_<32 hex chars>
```

Each placeholder is a keyed HMAC of the value, so within a session the same secret always maps to the
same placeholder and the model can still reason about it. When the model's response refers to a
placeholder, Ficta restores the real value locally before the agent sees it. If a registered secret
would still leave verbatim in a covered part of the request, Ficta **blocks the request** instead of
sending it.

## Quick start

```sh
npm install -g @serovaai/ficta   # or pnpm / bun
ficta setup                      # writes ~/.ficta/config.toml, optionally installs shims
ficta doctor claude              # check secrets load and routing works (or: codex / pi)
claude                           # now runs through Ficta
```

No shims? Launch explicitly with `ficta claude`, `ficta codex`, or `ficta pi`. Overhead is about
2–3 ms per request ([benchmarks](packages/ficta/docs/benchmarks.md)).

## Works with

| Agent                                                                | Status   |
| -------------------------------------------------------------------- | -------- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code)        | Verified |
| [Codex](https://github.com/openai/codex) (API key and ChatGPT login) | Verified |
| [Pi](https://github.com/badlogic/pi-mono)                            | Verified |

Ficta only supports CLI agents that send **all** model traffic through its proxy. IDE clients such as
Cursor are not supported: their agent features bypass a custom base URL
([why](packages/ficta/docs/threat-model.md#ide-clients-cursor-etc)).

## What it protects — and what it doesn't

| Layer                                                                                                                  | Guarantee                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Registered secrets** from `.env`, `.env.local`, Doppler, and secret-ish environment variables                        | Exact match. Fail-closed if one would leave verbatim.  |
| **Secret shapes** — API keys, JWTs, private keys, credential URLs, `API_TOKEN=...` (on by default)                     | Best effort. Catches newly pasted keys; pattern-based. |
| **PII** — emails, SSNs, card numbers; [Presidio](https://microsoft.github.io/presidio/) for broader detection (opt-in) | Best effort. Can miss values.                          |

Ficta does **not** catch secrets that are encoded or split up, unregistered values that don't look
like a known format, or anything the agent sends itself via `curl`, MCP tools, or other non-model
network traffic. It is secret hygiene and PII reduction, not enterprise DLP, a compliance product, or
a sandbox. Pair it with your agent's permission system and OS-level egress controls. The exact
boundary is in the [threat model](packages/ficta/docs/threat-model.md).

## Ficta Gateway — for teams

Worried about staff pasting client data into ChatGPT? **[Ficta Gateway](apps/gateway)** is a
self-hosted AI chat workspace on the same engine. Users see exactly what the model will receive
before they send, can protect anything the detectors missed, and admins turn those catches into
workspace policy. Provider keys stay server-side; responses are restored inside your environment.

Gateway is source-available (BUSL-1.1): free for evaluation, production use needs a commercial
license. See [ficta.sh](https://ficta.sh) or email [hello@ficta.sh](mailto:hello@ficta.sh).

## Docs

- [CLI install, configuration, and commands](packages/ficta/README.md)
- [Threat model](packages/ficta/docs/threat-model.md) — the exact promise, covered surfaces, and non-goals
- [Shims and runtime behavior](packages/ficta/docs/install.md)
- [Plugins](packages/ficta/docs/plugins.md) — registry sources, [secret-shape](packages/ficta/docs/plugins.md#built-in-detector-plugin-secret-shapes) and [PII](packages/ficta/docs/plugins.md#built-in-detector-plugin-pii) detectors, agent integrations
- [Codex ChatGPT/OAuth routing](packages/ficta/docs/codex-oauth-intercept.md)
- [Control-plane contract](packages/ficta/docs/control-plane.md) and [OpenAPI schema](packages/contract/openapi/ficta-control-plane.openapi.json) for frontend integrators
- [Gateway operator guide](apps/gateway/README.md) and [POC configuration](apps/gateway/docs/poc-configuration.md)
- [Security policy](packages/ficta/SECURITY.md)

## What's in this repo

| Path                                     | What                                                                                                                                            | License  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [`packages/ficta`](packages/ficta)       | [`@serovaai/ficta`](https://www.npmjs.com/package/@serovaai/ficta) — the CLI and proxy                                                          | MIT      |
| [`packages/engine`](packages/engine)     | [`@serovaai/ficta-engine`](https://www.npmjs.com/package/@serovaai/ficta-engine) — the redaction engine as an in-process library (experimental) | MIT      |
| [`packages/protocol`](packages/protocol) | [`@serovaai/ficta-protocol`](https://www.npmjs.com/package/@serovaai/ficta-protocol) — wire contract shared by proxy and Gateway                | MIT      |
| [`packages/contract`](packages/contract) | [`@serovaai/ficta-contract`](https://www.npmjs.com/package/@serovaai/ficta-contract) — OpenAPI control contract and typed client                | MIT      |
| [`apps/gateway`](apps/gateway)           | Ficta Gateway — self-hosted team chat workspace                                                                                                 | BUSL-1.1 |
| [`apps/web`](apps/web)                   | [ficta.sh](https://ficta.sh)                                                                                                                    | —        |

See [`LICENSING.md`](LICENSING.md) for details. Gateway versions up to commit `aacf45d` remain
AGPL-3.0-only.

## Status and contributing

Ficta uses normal semver releases. Exact-match redaction, restore, and fail-closed behavior are
covered by tests and real agent runs; run `ficta doctor <agent>` before relying on a setup, and test a
Gateway deployment with fake secrets and fake PII before using it on sensitive work.

Contributions welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the monorepo toolchain
and [`packages/ficta/CONTRIBUTING.md`](packages/ficta/CONTRIBUTING.md) for the guidelines.
