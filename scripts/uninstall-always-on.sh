#!/usr/bin/env bash
set -euo pipefail

APP_LABEL="com.michaelcaneyjr.overkillintel.app"
NGROK_LABEL="com.michaelcaneyjr.overkillintel.ngrok"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

uid="$(id -u)"

launchctl bootout "gui/$uid/$APP_LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$uid/$NGROK_LABEL" >/dev/null 2>&1 || true

rm -f "$LAUNCH_DIR/$APP_LABEL.plist" "$LAUNCH_DIR/$NGROK_LABEL.plist"

echo "Removed launch agents:"
echo "- $APP_LABEL"
echo "- $NGROK_LABEL"
