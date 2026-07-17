#!/usr/bin/env bash
# Ficta Gateway reference deployment — idempotent host install.
# Ubuntu 22.04/24.04. Run as root: sudo ./deploy/install.sh
# Safe to re-run: existing config files are never overwritten; builds and services converge.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SerovaAI/ficta.git}"
REPO_DIR="${REPO_DIR:-/opt/ficta}"
REPO_REF="${REPO_REF:-}" # branch, tag, or commit to deploy; empty = the checkout's current state
FICTA_USER="ficta"
FICTA_HOME="/var/lib/ficta"
ENV_DIR="/etc/ficta"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./deploy/install.sh)"
command -v apt-get >/dev/null || die "expects a Debian/Ubuntu host (apt-get not found)"

# --- 1. Host packages -------------------------------------------------------
log "Base packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git

if ! command -v docker >/dev/null; then
  log "Docker Engine + compose plugin (Docker apt repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  log "Docker already installed: $(docker --version)"
fi
docker compose version >/dev/null || die "docker compose v2 plugin missing"
systemctl enable --now docker

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "Node ${NODE_MAJOR}.x (NodeSource apt repo)"
  # Configure the repo directly instead of piping NodeSource's bootstrap script into root bash;
  # apt verifies package signatures against this key from here on.
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
else
  log "Node already installed: $(node --version)"
fi

log "pnpm via corepack"
corepack enable
corepack prepare pnpm@latest-10 --activate 2>/dev/null || corepack prepare pnpm@latest --activate

# --- 2. Service user --------------------------------------------------------
if ! id "$FICTA_USER" >/dev/null 2>&1; then
  log "Creating system user ${FICTA_USER} (home ${FICTA_HOME})"
  useradd --system --create-home --home-dir "$FICTA_HOME" --shell /usr/sbin/nologin "$FICTA_USER"
fi
install -d -o "$FICTA_USER" -g "$FICTA_USER" -m 0750 "$FICTA_HOME" "$FICTA_HOME/.ficta"

# --- 3. Checkout + build ----------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  log "Cloning ${REPO_URL} -> ${REPO_DIR}"
  git clone "$REPO_URL" "$REPO_DIR"
else
  log "Checkout exists at ${REPO_DIR} (not pulling automatically — run git pull to upgrade)"
fi
chown -R "$FICTA_USER:$FICTA_USER" "$REPO_DIR"

if [ -n "$REPO_REF" ]; then
  log "Checking out ${REPO_REF}"
  sudo -u "$FICTA_USER" git -C "$REPO_DIR" fetch --tags origin
  sudo -u "$FICTA_USER" git -C "$REPO_DIR" checkout --detach "$REPO_REF"
fi
DEPLOY_SHA="$(sudo -u "$FICTA_USER" git -C "$REPO_DIR" rev-parse HEAD)"
install -d -m 0750 "$ENV_DIR"
printf '%s\n' "$DEPLOY_SHA" > "$ENV_DIR/deployed-revision"
log "Deploying revision ${DEPLOY_SHA} (recorded in ${ENV_DIR}/deployed-revision)"

log "pnpm install + build (proxy, protocol, gateway)"
(cd "$REPO_DIR" && sudo -u "$FICTA_USER" env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile)
(cd "$REPO_DIR/packages/ficta" && sudo -u "$FICTA_USER" env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm build)
(cd "$REPO_DIR/apps/gateway" && sudo -u "$FICTA_USER" env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm build)

# --- 4. Sidecars + Postgres -------------------------------------------------
log "Sidecars (document-converter + presidio-analyzer)"
docker compose -f "$REPO_DIR/docker-compose.sidecars.yml" \
  --profile gateway --profile engine up -d --build --wait

if grep -qs '^DATABASE_URL=postgres' "$ENV_DIR/gateway.env" 2>/dev/null &&
   ! grep -qs '^DATABASE_URL=postgres://ficta:.*@127.0.0.1' "$ENV_DIR/gateway.env" 2>/dev/null; then
  log "External DATABASE_URL configured — skipping local Postgres container"
  if docker ps -aq -f name='^ficta-postgres$' | grep -q .; then
    log "Stopping unused local ficta-postgres container (data volume preserved)"
    docker stop ficta-postgres >/dev/null && docker rm ficta-postgres >/dev/null
  fi
else
  log "Local Postgres container (loopback, persistent volume)"
  if [ ! -f "$ENV_DIR/postgres.env" ]; then
    # Never regenerate credentials under an existing deployment: if gateway.env already points at
    # the local container, a fresh password would strand the data in the volume.
    if grep -qs 'DATABASE_URL=postgres://ficta:' "$ENV_DIR/gateway.env" 2>/dev/null; then
      die "$ENV_DIR/gateway.env references the local Postgres container but $ENV_DIR/postgres.env is missing; restore postgres.env from backup (or point DATABASE_URL at your managed instance) before re-running"
    fi
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$ENV_DIR/postgres.env"
    chmod 600 "$ENV_DIR/postgres.env"
  fi
  docker compose -f "$REPO_DIR/deploy/docker-compose.postgres.yml" \
    --env-file "$ENV_DIR/postgres.env" up -d --wait
fi

# --- 5. Config files (never overwritten) ------------------------------------
log "Config: ${ENV_DIR}/*.env and ~${FICTA_USER}/.ficta/config.toml"
install -d -m 0750 "$ENV_DIR"
for f in gateway.env proxy.env; do
  if [ ! -f "$ENV_DIR/$f" ]; then
    install -m 0640 -g "$FICTA_USER" "$REPO_DIR/deploy/env/${f}.example" "$ENV_DIR/$f"
    # Inject the generated local-Postgres password into a fresh gateway.env
    if [ "$f" = gateway.env ] && [ -f "$ENV_DIR/postgres.env" ]; then
      # shellcheck disable=SC1091
      . "$ENV_DIR/postgres.env"
      sed -i "s|^#* *DATABASE_URL=.*|DATABASE_URL=postgres://ficta:${POSTGRES_PASSWORD}@127.0.0.1:5432/ficta|" "$ENV_DIR/$f"
    fi
    echo "    installed $ENV_DIR/$f — EDIT THIS (placeholders inside)"
  fi
done
if [ ! -f "$FICTA_HOME/.ficta/config.toml" ]; then
  install -o "$FICTA_USER" -g "$FICTA_USER" -m 0640 \
    "$REPO_DIR/deploy/ficta-config.toml" "$FICTA_HOME/.ficta/config.toml"
fi
# --- 6. systemd units -------------------------------------------------------
log "systemd units"
sed "s|@REPO_DIR@|$REPO_DIR|g" "$REPO_DIR/deploy/systemd/ficta-proxy.service" \
  > /etc/systemd/system/ficta-proxy.service
sed "s|@REPO_DIR@|$REPO_DIR|g" "$REPO_DIR/deploy/systemd/ficta-gateway.service" \
  > /etc/systemd/system/ficta-gateway.service
systemctl daemon-reload
systemctl enable ficta-proxy ficta-gateway

if grep -Eq '^[A-Za-z_]+=.*CHANGE_ME' "$ENV_DIR/gateway.env"; then
  log "NOT starting services: $ENV_DIR/gateway.env still contains CHANGE_ME placeholders."
  echo "    Edit it, then: systemctl restart ficta-proxy ficta-gateway"
else
  systemctl restart ficta-proxy ficta-gateway
  log "Services started."
fi

log "Done. Next: deploy/README.md → Verify (ficta doctor, health checks, fail-closed drill)."
