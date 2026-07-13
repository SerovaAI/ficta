#!/bin/sh
set -eu

exec poetry run gunicorn -w "${WORKERS:-1}" -b "0.0.0.0:${PORT:-3000}" "ficta_presidio.service:create_app()"
