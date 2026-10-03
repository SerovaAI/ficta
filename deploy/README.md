# Ficta Gateway reference deployment

An executable version of the operational posture described in
[`apps/gateway/README.md`](../apps/gateway/README.md) ("Production-Like Gateway Setup") and
[`apps/gateway/docs/poc-configuration.md`](../apps/gateway/docs/poc-configuration.md). One Linux
host runs the whole stack. The loopback bindings below control _inbound_ exposure; restricting
_outbound_ traffic to the approved model-provider endpoint is enforced by your firewall/network
policy, not by the stack itself — see "Egress allow-list".

```text
[users' browsers]
      │ HTTPS (your TLS — Caddy example included, or your reverse proxy)
      ▼
[Gateway  :3000 loopback]──►[ficta proxy :8787 loopback]
      │                            ├──► presidio-analyzer   127.0.0.1:5002 (container)
      │                            └──► (egress) approved provider endpoint only
      ├──► document-converter      127.0.0.1:5003 (container)
      └──► PostgreSQL              127.0.0.1:5432 (container w/ volume, or your managed instance)
```

Supervision model: the two Node services (Gateway, proxy) run under **systemd**; the sidecars and
Postgres run under **Docker with `restart: unless-stopped`**, so everything survives a reboot.

## Prerequisites

- Ubuntu 22.04/24.04 LTS (or equivalent), 4 vCPU / 16 GB RAM / 100 GB disk.
- Root (sudo) access. Internet egress during install only (Docker/apt/npm registries); afterwards
  egress can be restricted to the provider endpoint.
- An internal DNS name and, in production, your TLS story at the reverse proxy.

## Install

```sh
sudo ./deploy/install.sh                          # from the repository root
# pin a release/commit, or install from a fork/mirror:
sudo REPO_REF=v1.2.3 REPO_URL=https://github.com/SerovaAI/ficta.git ./deploy/install.sh
```

The exact commit deployed is resolved and recorded in `/etc/ficta/deployed-revision` before the
build, so repeated installs are attributable and reproducible; set `REPO_REF` to pin a trusted
tag/commit rather than deploying whatever the checkout happens to be on.

The script is idempotent — re-running it converges the host. It performs, in order:

1. **Host packages** — Docker Engine + compose v2 plugin from Docker's apt repo; Node 22 from
   NodeSource; corepack-managed pnpm; git.
2. **Service user** — a `ficta` system user (home `/var/lib/ficta`, holding `.ficta/config.toml`,
   the surrogate key `.ficta/surrogate.key`, the shared managed-registry file, and PGlite-free
   runtime state).
3. **Checkout + build** — clone/update to `/opt/ficta`, `pnpm install`, build the proxy
   (`packages/ficta`) and the Gateway (`apps/gateway` → `.output/`).
4. **Sidecars** — build and start `document-converter` + `presidio-analyzer` via the root
   `docker-compose.sidecars.yml` (profiles `gateway,engine`), plus Postgres via
   `deploy/docker-compose.postgres.yml` (pinned image, loopback bind, persistent volume) unless
   `DATABASE_URL` points at a managed instance.
5. **Config** — install `/etc/ficta/gateway.env` and `/etc/ficta/proxy.env` from the templates in
   `deploy/env/` (only if absent — your edits are never overwritten), and the proxy policy
   `~ficta/.ficta/config.toml` from `deploy/ficta-config.toml` (fail-closed POC policy:
   `registry.require`, `secret_shapes`, `pii.fail_closed`, and a required stable surrogate key).
   Generate the surrogate key `/var/lib/ficta/.ficta/surrogate.key` once (see "Surrogate key"),
   then preflight it: the script stops if the key is missing, not a regular file, not owned by
   `ficta`, readable by group/others, or not 64 hex characters.
6. **systemd** — install and enable `ficta-proxy.service` and `ficta-gateway.service`.

After the first run, **edit the env files** (they are installed with placeholder values and the
services will not be started until required values are present):

- `/etc/ficta/gateway.env` — provider key(s), `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET`,
  `DATABASE_URL`, and the WorkOS/Entra block for authenticated deployments.
- `/etc/ficta/proxy.env` — normally nothing to change; policy lives in `config.toml`.

Then: `sudo systemctl restart ficta-proxy ficta-gateway`.

## Verify (do this before trusting the deployment)

```sh
# 1. Proxy protection state — expect "N protected values", require-registry: on, and
#    "surrogate key: stable (config.toml surrogate.key_file: /var/lib/ficta/.ficta/surrogate.key)"
sudo -u ficta node /opt/ficta/packages/ficta/bin/ficta.mjs doctor

# 2. Health endpoints
curl -fsS http://127.0.0.1:5002/health   # presidio
curl -fsS http://127.0.0.1:5003/health   # document converter
curl -fsS http://127.0.0.1:3000/         # gateway (via caddy: https://<host>/)

# 3. Fail-closed drill — stop the detector, send a chat message, expect a block (not a forward)
docker compose -f /opt/ficta/docker-compose.sidecars.yml --profile engine stop presidio-analyzer
#   ...send a message in the Gateway UI: it must be blocked...
docker compose -f /opt/ficta/docker-compose.sidecars.yml --profile engine start presidio-analyzer
```

With `[registry] require = true`, provider traffic stays paused until a registry source is healthy
and non-empty — load registry values via **Admin → Protected Registry** (CSV import supported)
before expecting requests to flow.

## Runbook

Rehearse each of these once on a fresh install; a pilot's acceptance criteria include an exercised
runbook.

**Restart / reboot**

```sh
sudo systemctl restart ficta-proxy ficta-gateway     # services
sudo reboot                                           # full host: everything must come back on its own
systemctl status ficta-proxy ficta-gateway            # after reboot
docker ps                                             # sidecars up (+ postgres on local-container deployments)
```

**Backup** (contains sensitive data — restored chat transcripts, the protected registry, and the
surrogate key; store per the firm's policy)

Database — local Postgres container deployments:

```sh
docker exec ficta-postgres pg_dump -U ficta ficta | gzip > ficta-db-$(date +%F).sql.gz
```

Database — managed `DATABASE_URL` deployments: use your provider's backup/snapshot and
point-in-time-recovery procedures instead; the container commands here do not apply.

Configuration (all deployments):

```sh
sudo tar czf ficta-config-$(date +%F).tgz /etc/ficta /var/lib/ficta/.ficta \
    /var/lib/ficta/protected-registry.json
```

The configuration archive includes the surrogate key (`/var/lib/ficta/.ficta/surrogate.key`).
Escrow the key separately as well, like `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET`, so a lost host can be
rebuilt with the same key.

`FICTA_GATEWAY_KEY_ENCRYPTION_SECRET` must be escrowed separately from the database backup —
backups contain encrypted workspace provider keys and are useless without it.

**Restore** (onto a host prepared by `install.sh`)

```sh
sudo systemctl stop ficta-gateway ficta-proxy
# local Postgres container deployments (managed DATABASE_URL: restore via your provider instead):
gunzip -c ficta-db-<date>.sql.gz | docker exec -i ficta-postgres psql -U ficta ficta
sudo tar xzf ficta-config-<date>.tgz -C /   # restores the surrogate key over the one install.sh generated
sudo systemctl start ficta-proxy ficta-gateway
```

Restore the surrogate key before starting the proxy, and keep it `ficta`-owned and mode `0600`
(`tar` run as root preserves both).

**Surrogate key**

The proxy turns every protected value into a token with a keyed HMAC, so the key decides which token
each value gets. `install.sh` creates it once at `/var/lib/ficta/.ficta/surrogate.key` (64 hex
characters from `openssl rand -hex 32`, owner `ficta`, mode `0600`), never prints it, and never
overwrites an existing one. `deploy/ficta-config.toml` points `surrogate.key_file` at it and sets
`surrogate.require_stable_key = true`, so a missing or unusable key stops the proxy at startup
(exit status 2) instead of silently using a random per-process key that changes every token on
restart.

- **Back it up and escrow it** with the other deployment secrets. Never commit it or paste it into a
  ticket.
- **Losing or rotating it changes every surrogate.** Tokens minted under the old key can no longer
  be restored: a response in flight across the change, or a model echoing a token from before it,
  comes back unrestored. Stored chat history is unaffected — the Gateway stores the
  transcript after the proxy has restored it, as plaintext, not as surrogates.
- **To rotate deliberately** (for example after suspected exposure), stop the proxy, replace the
  file with a new key (same owner and mode), and start it again during a quiet period.
- **Hosts installed before the key existed** keep their old `config.toml` (it is never
  overwritten); `install.sh` creates the key and warns until you add the `[surrogate]` block from
  `deploy/ficta-config.toml`.

**Upgrade**

```sh
cd /opt/ficta && sudo -u ficta git pull
sudo ./deploy/install.sh          # converges: rebuild, sidecar image refresh, service restart
```

## Egress allow-list

After install, host egress can be restricted to the single approved provider endpoint
(`api.openai.com` or `api.anthropic.com`) on 443. Everything else — sidecars, Postgres, the
Gateway/proxy hop — is loopback. Remember the WorkOS endpoints if `AUTH_PROVIDER=workos`
(identity metadata only). Package-registry egress is needed again only during upgrades.

## Files

| Path                            | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `install.sh`                    | Idempotent host bootstrap + build + service install     |
| `systemd/ficta-proxy.service`   | ficta redaction proxy unit                              |
| `systemd/ficta-gateway.service` | Gateway web app unit                                    |
| `docker-compose.postgres.yml`   | Pinned loopback Postgres with persistent volume         |
| `env/gateway.env.example`       | Gateway environment template → `/etc/ficta/gateway.env` |
| `env/proxy.env.example`         | Proxy environment template → `/etc/ficta/proxy.env`     |
| `ficta-config.toml`             | Fail-closed proxy policy → `~ficta/.ficta/config.toml`  |
| `surrogate-key.sh`              | Surrogate key creation + preflight (used by install.sh) |
| `Caddyfile.example`             | Internal-TLS reverse proxy example                      |
