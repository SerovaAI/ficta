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
```

This keeps provider traffic paused until an enabled registry source is healthy and non-empty,
enables local secret-shape detection, and blocks rather than forwarding unscreened text when the
selected Presidio sidecar is unavailable. Coding-agent detection remains off unless the separate
`agents` settings are enabled.

Run the Presidio analyzer under the installer-controlled process or container supervisor at its
default `http://127.0.0.1:5002` address. Populate the Gateway Protected Registry with representative
client names, matter identifiers, account numbers, or other high-value exact values before testing
provider traffic.

## Settings intentionally omitted

Local defaults already cover the proxy and sidecar URLs, ports, embedded PGlite storage, managed
registry file, surrogate-key generation, logging, and fail-closed exact-value redaction. Do not copy
their defaults into the environment merely to make them explicit.

Use environment variables only when the deployment topology changes—for example `FICTA_PROXY_URL`,
`FICTA_CONFIG_FILE`, `DATABASE_URL`, or the shared managed-registry path. For every policy and backend
tuning option, see [`../config.toml.example`](../config.toml.example). For authenticated or
multi-process deployment requirements, see the
[Gateway operator guide](https://github.com/SerovaAI/ficta/tree/main/apps/gateway#production-like-gateway-setup).

Automated source-checkout demos and smoke tests may inject the same policy through environment
overrides to stay hermetic. Treat those variables as test-harness plumbing, not as a second operator
configuration contract.
