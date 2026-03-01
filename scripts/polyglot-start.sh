#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/polyglot_host.pid"
LOG_FILE="/tmp/polyglot_host.log"
HOST="${POLYGLOT_HOST:-127.0.0.1}"
PORT="${POLYGLOT_PORT:-8787}"

is_healthy() {
  python3 - <<PY
import json, sys, urllib.request
base = "http://$HOST:$PORT"
try:
    payload = json.loads(urllib.request.urlopen(base + "/healthz", timeout=2).read().decode())
    ok = bool(payload.get("ok")) and payload.get("service") == "polyglot_mission_host"
    print("1" if ok else "0")
except Exception:
    print("0")
PY
}

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "polyglot-host already running (pid=$old_pid)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [[ "$(is_healthy)" == "1" ]]; then
  existing_pid=""
  if command -v lsof >/dev/null 2>&1; then
    existing_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
  fi
  if [[ -n "$existing_pid" ]]; then
    echo "$existing_pid" > "$PID_FILE"
    echo "polyglot-host already running on port $PORT (pid=$existing_pid)"
  else
    echo "polyglot-host already running on port $PORT"
  fi
  exit 0
fi

cd "$ROOT_DIR"
nohup env PYTHONUNBUFFERED=1 POLYGLOT_HOST="$HOST" POLYGLOT_PORT="$PORT" \
  python3 polyglot_host.py > "$LOG_FILE" 2>&1 < /dev/null &
new_pid=$!
echo "$new_pid" > "$PID_FILE"
sleep 1

if kill -0 "$new_pid" 2>/dev/null; then
  echo "polyglot-host started: pid=$new_pid url=http://$HOST:$PORT/"
elif [[ "$(is_healthy)" == "1" ]]; then
  adopted_pid=""
  if command -v lsof >/dev/null 2>&1; then
    adopted_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
  fi
  if [[ -n "$adopted_pid" ]]; then
    echo "$adopted_pid" > "$PID_FILE"
    echo "polyglot-host reachable on http://$HOST:$PORT/ (pid=$adopted_pid)"
  else
    rm -f "$PID_FILE"
    echo "polyglot-host reachable on http://$HOST:$PORT/"
  fi
else
  echo "failed to start polyglot-host; see $LOG_FILE"
  exit 1
fi
