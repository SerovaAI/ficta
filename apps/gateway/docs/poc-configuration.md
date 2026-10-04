# POC configuration

This is the canonical configuration contract for an operator-installed, isolated Ficta Gateway POC.
It keeps protection policy in the proxy's persistent TOML file and reserves environment variables
for secrets and deployment wiring.

## Gateway environment

Set one fallback provider key:

```dotenv
OPENAI_API_KEY=...
# or: ANTHROPIC_API_KEY=...
```

If administrators will save workspace-scoped provider keys through Gateway, also set a stable
encryption secret outside the database:

```dotenv
FICTA_GATEWAY_KEY_ENCRYPTION_SECRET=...
```

Generate it with `openssl rand -base64 32`. No other environment setting is required when Gateway,
the proxy, and the sidecars use their local defaults.

Optionally, a hosted second opinion can mark lines in pre-send review that may still name a party
or state a commercial term. It is advisory and fail-open, and it sends detected spans and their
lines to TypeSafe; read the "Optional second-opinion service" section of the
[PII threat model](./threat-model-pii.md) before setting the key. The key makes the feature
available; an admin then turns it on under Admin settings → Second opinion:

```dotenv
TYPESAFE_API_KEY...
```

## Proxy policy

Run `ficta setup`, then make the following the effective policy in `~/.ficta/config.toml`:

```toml
[registry]
require = true

[secret_shapes]
enabled = true

[pii]
enabled = true
backends = ["presidio"]
fail_closed = true

[redaction]
redact_paths = true

[detection]
fail_closed = true
entity_priority = ["za-id-number", "credit-card"]

[dispositions.destroy]
categories = ["credit-card", "za-id-number"]
```

This keeps provider traffic paused until an enabled registry source is healthy and non-empty,
enables local secret-shape detection, and blocks rather than forwarding unscreened text when the
selected Presidio sidecar is unavailable. Coding-agent detection remains off unless the separate
`agents` settings are enabled.

### Surrogate key

The proxy derives every surrogate from a local HMAC key. Give the deployment a stable key file so
tokens survive proxy restarts, and make startup fail without it:

```toml
[surrogate]
key_file = "/var/lib/ficta/.ficta/surrogate.key"
require_stable_key = true
```

The file holds 64 hex characters (`openssl rand -hex 32`), is owned by the proxy's service user, and
must not be readable by group or others (`chmod 600`); the proxy refuses it otherwise. The reference
deployment's `deploy/install.sh` creates it once at that path and never overwrites it. Without a key
the proxy falls back to a random per-process key and every restart changes every token;
`require_stable_key` turns that fallback into a startup failure (exit status 2). An inline
`surrogate.key` written by `ficta setup` is also stable and takes precedence over `key_file`; keep
only one of them. `ficta doctor` reports which key is active and whether it is stable.

Treat the key like `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET`: back it up, escrow it, and never commit it.
Losing or rotating it changes every surrogate, so a token minted under the old key (a response in
flight across the change, or a model echoing an earlier token) can no longer be restored. Stored chat
history is unaffected: Gateway saves the transcript after the proxy restores it, as plaintext.

Run the Presidio analyzer under the installer-controlled process or container supervisor at its
default `http://127.0.0.1:5002` address. Populate the Gateway Protected Registry with representative
client names, matter identifiers, account numbers, or other high-value exact values before testing
provider traffic.

## Settings intentionally omitted

Local defaults already cover the proxy and sidecar URLs, ports, embedded PGlite storage, managed
registry file, logging, and fail-closed exact-value redaction. Do not copy
their defaults into the environment merely to make them explicit.

Use environment variables only when the deployment topology changes—for example `FICTA_PROXY_URL`,
`FICTA_CONFIG_FILE`, `DATABASE_URL`, or the shared managed-registry path. For every policy and backend
tuning option, see [`packages/ficta/config.toml.example`](../../../packages/ficta/config.toml.example). For authenticated or
multi-process deployment requirements, see the
[Gateway operator guide](https://github.com/SerovaAI/ficta/tree/main/apps/gateway#production-like-gateway-setup).

Automated source-checkout demos and smoke tests may inject the same policy through environment
overrides to stay hermetic. Treat those variables as test-harness plumbing, not as a second operator
configuration contract.
