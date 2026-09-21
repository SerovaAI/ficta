#!/bin/sh
set -eu

exec python -m gunicorn -w "${WORKERS:-1}" -b "0.0.0.0:${PORT:-3000}" "ficta_presidio.service:create_app()"
