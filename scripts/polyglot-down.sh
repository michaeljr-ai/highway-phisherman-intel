#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
cd "$ROOT_DIR"
if [[ -f "$ENV_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f docker-compose.polyglot.yml down
else
  docker compose -f docker-compose.polyglot.yml down
fi
