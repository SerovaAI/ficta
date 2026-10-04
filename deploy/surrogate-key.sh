# shellcheck shell=bash
# Surrogate key helpers for the reference deployment. Sourced by deploy/install.sh; exercised by
# scripts/deploy-surrogate-key.test.mjs. Neither function ever prints the key.
#
# The proxy derives every surrogate from this key. Replacing it changes every surrogate, so tokens
# minted under the old key (streams in flight, preview tickets, anything a model echoes back later)
# can no longer be restored. That is why an existing key is never regenerated or overwritten here.

# surrogate_key_ensure FILE OWNER GROUP
# Create FILE with a fresh 256-bit key (64 hex characters) if it does not exist. An existing regular
# file is kept byte-for-byte; only its owner and mode are converged to OWNER:GROUP 0600.
surrogate_key_ensure() {
  local file="$1" owner="$2" group="$3" tmp
  if [ -L "$file" ]; then
    printf 'surrogate key %s is a symlink; replace it with a regular file\n' "$file" >&2
    return 1
  fi
  if [ -e "$file" ]; then
    [ -f "$file" ] || {
      printf 'surrogate key %s exists but is not a regular file\n' "$file" >&2
      return 1
    }
    chown "$owner:$group" "$file" && chmod 0600 "$file"
    return
  fi
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
  if ! openssl rand -hex 32 >"$tmp" || ! chown "$owner:$group" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  # A hard link never replaces an existing path, so a concurrent run cannot clobber a key.
  if ! ln "$tmp" "$file"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

# surrogate_key_check FILE OWNER
# Preflight: report (on stderr) and fail when FILE is missing, not a regular file, not owned by OWNER,
# accessible by group/others, or does not hold exactly 64 hex characters. Apart from ownership, these
# are the conditions under which the proxy (with surrogate.require_stable_key) refuses to start.
surrogate_key_check() {
  local file="$1" owner="$2" key
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
    printf 'surrogate key %s is not a regular file\n' "$file" >&2
    return 1
  fi
  if [ ! -e "$file" ]; then
    printf 'surrogate key %s is missing\n' "$file" >&2
    return 1
  fi
  if [ -z "$(find "$file" -maxdepth 0 -user "$owner")" ]; then
    printf 'surrogate key %s is not owned by %s\n' "$file" "$owner" >&2
    return 1
  fi
  if [ -n "$(find "$file" -maxdepth 0 \( -perm -040 -o -perm -020 -o -perm -010 \
    -o -perm -004 -o -perm -002 -o -perm -001 \))" ]; then
    printf 'surrogate key %s is accessible by group/others; run chmod 600 %s\n' "$file" "$file" >&2
    return 1
  fi
  if ! key="$(cat "$file" 2>/dev/null)"; then
    printf 'surrogate key %s is not readable\n' "$file" >&2
    return 1
  fi
  if ! [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    printf 'surrogate key %s must contain exactly 64 hex characters\n' "$file" >&2
    return 1
  fi
}
