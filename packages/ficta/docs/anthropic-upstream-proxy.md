# Routing `ficta claude` through a local Anthropic-compatible proxy

*How to point ficta's Anthropic route at a local provider-proxy so `ficta claude` can drive a model
ficta doesn't reach natively — e.g. an OpenAI/Codex or Gemini model behind a subscription — while
ficta redaction stays fully in the loop. Concrete example here: running GPT‑5.6 "sol" on a ChatGPT
subscription via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).*

## Runtime model

`ficta claude` already sets `ANTHROPIC_BASE_URL` to its ephemeral loopback proxy for the launched
process (see [`codex-oauth-intercept.md`](./codex-oauth-intercept.md) for the sibling Codex flow).
That proxy forwards the **anthropic** route (the Claude Messages API, `POST /v1/messages`) to whatever
`upstreams.anthropic` points at — `https://api.anthropic.com` by default.

Override that one hop and the chain becomes:

```
ficta claude ──▶ ficta proxy (redacts body) ──▶ your local Anthropic-compatible proxy ──▶ the model
   (Claude Code)   Authorization forwarded          (must speak POST /v1/messages)        restored ◀──
```

Nothing else changes: your `Authorization` and model name pass through untouched, the request body is
redacted before it leaves ficta, and surrogates are restored in the response. **Do not set
`ANTHROPIC_BASE_URL` yourself** — ficta owns it for the launched agent; setting it is a no-op that
only confuses debugging.

## Why loopback needs no extra flag

`FICTA_ANTHROPIC_UPSTREAM` sets `upstreams.anthropic`. Upstream policy (`config.ts`):

- **Loopback** targets (`127.0.0.1`, `localhost`, `::1`) are always allowed and receive forwarded
  provider auth headers — no `FICTA_ALLOW_CUSTOM_UPSTREAM` needed.
- **Non-loopback** custom upstreams require `FICTA_ALLOW_CUSTOM_UPSTREAM=1` **and** `https`.

Because a local provider-proxy is loopback, this is a one-variable change.

## Setup

Point the anthropic route at your local proxy and pass the downstream's key + model through as normal
Claude Code env. The downstream proxy must expose the Anthropic Messages API and validate whatever
token you forward.

```sh
export FICTA_ANTHROPIC_UPSTREAM="http://127.0.0.1:8317"   # your local Anthropic-compatible proxy
export ANTHROPIC_AUTH_TOKEN="<downstream-proxy-key>"       # forwarded verbatim to that proxy
ficta claude --model gpt-5.6-sol    # or `claude` after `ficta install` — NOT the real binary; don't set ANTHROPIC_BASE_URL
```

**Pass the model with `--model`, not `ANTHROPIC_MODEL`.** With the 1M-context beta enabled, Claude
Code decorates the `ANTHROPIC_MODEL` value with a `[1m]` suffix (e.g. sends `gpt-5.6-sol[1m]` to
`/v1/messages?beta=true`), which a non-Anthropic downstream won't recognize — CLIProxyAPI returns
`502 unknown provider for model gpt-5.6-sol[1m]`. The `--model` flag pins the exact string and skips
the suffix. Set `CLAUDE_CODE_SUBAGENT_MODEL=<model>` to keep subagents on the same model.

Keep `FICTA_ANTHROPIC_UPSTREAM` a **per-shell export** (or a small alias/function), not a
`config.toml` `[upstreams] anthropic = …` — persisting it in config would route **all** your
`ficta claude` usage through the downstream proxy, not just the sessions where you want the alt model.

An alias keeps it to one command:

```sh
claudex() {
  local key="<downstream-proxy-key>"
  FICTA_ANTHROPIC_UPSTREAM="http://127.0.0.1:8317" \
  ANTHROPIC_AUTH_TOKEN="$key" \
  CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol \
    command claude --model gpt-5.6-sol "$@"
}
```

## Verify

Confirm the override took, without exposing secrets:

```sh
ficta doctor claude   # upstreams → `anthropic: http://127.0.0.1:8317`
```

Then a live check through the full chain:

```sh
curl -s http://127.0.0.1:8317/v1/messages \
  -H "Authorization: Bearer <downstream-proxy-key>" \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gpt-5.6-sol","max_tokens":32,"messages":[{"role":"user","content":"say: ok"}]}'
```

For a redaction proof, use a **fake fixture value**, never a real `.env` secret. Register a throwaway
value (e.g. an `ACME_DB_PASSWORD` in a scratch `.env`), send it in a prompt through the ficta proxy,
and watch the metadata log:

```
registered-value hits (1 paths; N values loaded): ACME_DB_PASSWORD
→ POST /v1/messages → http://127.0.0.1:8317/v1/messages [anthropic]
🔒 kept 1 body value(s) out of the model   (leaked 0)
♻️ restored 1 value(s) in response
```

`kept … out of the model` on the way up and `restored …` on the way back down is the guarantee: the
downstream proxy and the model only ever saw a surrogate.

## Notes

- **Detectors are per-surface.** For agent launches, secret-shape and PII detection follow
  `[secret_shapes].agents` / `[pii].agents` (both default off), so a Presidio outage that blocks the
  standalone/web proxy does not block `ficta claude`. Exact registered-value redaction always applies.
- **The downstream must speak the anthropic wire.** ficta forwards `POST /v1/messages` verbatim; the
  proxy is responsible for translating to its backend (CLIProxyAPI translates Anthropic ⇄ Codex/OpenAI/Gemini).
- **Auth is pass-through.** ficta forwards `Authorization` / `x-api-key` untouched to loopback
  upstreams; it injects no key of its own. The token you export must be one the downstream accepts.
- **This is the anthropic route only.** Routing Codex model traffic is a different mechanism — see
  [`codex-oauth-intercept.md`](./codex-oauth-intercept.md).
- Bypass ficta for one run with `FICTA_DISABLE=1 claude` (no redaction, and your own
  `ANTHROPIC_BASE_URL` is honored again).
