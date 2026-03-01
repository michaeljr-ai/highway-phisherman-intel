#!/usr/bin/env bash
set -euo pipefail

LABEL="com.michaelcaneyjr.overkillintel.polyglot"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
uid="$(id -u)"

launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
rm -f "$LAUNCH_DIR/$LABEL.plist"

echo "Removed launch agent: $LABEL"
