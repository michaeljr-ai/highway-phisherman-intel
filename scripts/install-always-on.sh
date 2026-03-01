#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$ROOT_DIR/.runlogs"
APP_ENV_FILE="$ROOT_DIR/.env"
APP_VERCEL_ENV_FILE="$ROOT_DIR/.env.vercel"
RUNTIME_ENV_FILE="$HOME/.overkillintel.env"
NGROK_GLOBAL_CONFIG="$HOME/Library/Application Support/ngrok/ngrok.yml"
NGROK_PROJECT_CONFIG="$ROOT_DIR/ngrok/overkill.yml"
NGROK_BIN="$(command -v ngrok || true)"

APP_LABEL="com.michaelcaneyjr.overkillintel.app"
NGROK_LABEL="com.michaelcaneyjr.overkillintel.ngrok"

if [[ -z "$NGROK_BIN" ]]; then
  echo "ngrok not found in PATH" >&2
  exit 1
fi

if [[ ! -f "$NGROK_GLOBAL_CONFIG" ]]; then
  echo "ngrok global config missing at: $NGROK_GLOBAL_CONFIG" >&2
  echo "Run: ngrok config add-authtoken <TOKEN>" >&2
  exit 1
fi

mkdir -p "$LAUNCH_DIR" "$LOG_DIR" "$ROOT_DIR/ngrok"

# LaunchAgents can fail to source files under ~/Documents due macOS privacy restrictions.
# Build a runtime env file under $HOME and source that at startup.
{
  if [[ -f "$APP_ENV_FILE" ]]; then
    cat "$APP_ENV_FILE"
  fi
  if [[ -f "$APP_VERCEL_ENV_FILE" ]]; then
    cat "$APP_VERCEL_ENV_FILE"
  fi
} > "$RUNTIME_ENV_FILE"
chmod 600 "$RUNTIME_ENV_FILE"

cat > "$NGROK_PROJECT_CONFIG" <<YAML
version: "3"
tunnels:
  overkill-intel:
    proto: http
    addr: 4010
    inspect: false
YAML

APP_PLIST="$LAUNCH_DIR/$APP_LABEL.plist"
cat > "$APP_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$APP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT_DIR' && if [[ -f '$RUNTIME_ENV_FILE' ]]; then set -a; source '$RUNTIME_ENV_FILE'; set +a; fi; export PRIVATE_MODE=\${PRIVATE_MODE:-false}; export RBAC_ENABLED=\${RBAC_ENABLED:-false}; export RBAC_REQUIRE_KEYS=\${RBAC_REQUIRE_KEYS:-false}; npm start</string>
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
  <string>$LOG_DIR/app.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/app.err.log</string>
</dict>
</plist>
PLIST

NGROK_PLIST="$LAUNCH_DIR/$NGROK_LABEL.plist"
cat > "$NGROK_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$NGROK_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>$NGROK_BIN start overkill-intel --config '$NGROK_GLOBAL_CONFIG,$NGROK_PROJECT_CONFIG'</string>
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
  <string>$LOG_DIR/ngrok.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/ngrok.err.log</string>
</dict>
</plist>
PLIST

uid="$(id -u)"

launchctl bootout "gui/$uid/$APP_LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$uid/$NGROK_LABEL" >/dev/null 2>&1 || true

launchctl bootstrap "gui/$uid" "$APP_PLIST"
launchctl bootstrap "gui/$uid" "$NGROK_PLIST"

launchctl kickstart -k "gui/$uid/$APP_LABEL"
launchctl kickstart -k "gui/$uid/$NGROK_LABEL"

echo "Installed and started:"
echo "- $APP_LABEL"
echo "- $NGROK_LABEL"

echo "ngrok public URL (if ready):"
bash "$ROOT_DIR/scripts/ngrok-url.sh" || true
