#!/usr/bin/env bash
set -euo pipefail

APP_LABEL="com.michaelcaneyjr.overkillintel.app"
NGROK_LABEL="com.michaelcaneyjr.overkillintel.ngrok"
uid="$(id -u)"

for label in "$APP_LABEL" "$NGROK_LABEL"; do
  echo "=== $label ==="
  launchctl print "gui/$uid/$label" | sed -n '1,40p' || true
  echo
  done

echo "Current ngrok URL:"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ngrok-url.sh" || true
