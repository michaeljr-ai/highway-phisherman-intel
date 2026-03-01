#!/usr/bin/env bash
set -euo pipefail

LABEL="com.michaelcaneyjr.overkillintel.polyglot"
uid="$(id -u)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

launchctl print "gui/$uid/$LABEL" | sed -n '1,80p' || true

echo
echo "Compose services:"
if [[ -f "$ENV_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.polyglot.yml" ps || true
else
  docker compose -f "$ROOT_DIR/docker-compose.polyglot.yml" ps || true
fi

echo
echo "ngrok URL:"
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ngrok-url.sh" || true
