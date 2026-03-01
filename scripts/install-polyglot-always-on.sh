#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$ROOT_DIR/.runlogs"
LABEL="com.michaelcaneyjr.overkillintel.polyglot"

mkdir -p "$LAUNCH_DIR" "$LOG_DIR"

PLIST="$LAUNCH_DIR/$LABEL.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT_DIR' &amp;&amp; bash scripts/polyglot-up.sh &amp;&amp; docker compose -f docker-compose.polyglot.yml logs -f</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/polyglot.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/polyglot.err.log</string>
</dict>
</plist>
PLIST

uid="$(id -u)"
launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$PLIST"
launchctl kickstart -k "gui/$uid/$LABEL"

echo "Installed and started: $LABEL"
