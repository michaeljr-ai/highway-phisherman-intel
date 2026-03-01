#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/polyglot_host.pid"
LOG_FILE="/tmp/polyglot_host.log"
HOST="${POLYGLOT_HOST:-127.0.0.1}"
PORT="${POLYGLOT_PORT:-8787}"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "pid: $pid (running)"
  else
    echo "pid file exists but process not running: $pid"
  fi
else
  echo "pid: none"
fi

python3 - <<PY
import json, urllib.request
base='http://$HOST:$PORT'
try:
    health=json.loads(urllib.request.urlopen(base+'/healthz', timeout=8).read().decode())
    status=json.loads(urllib.request.urlopen(base+'/api/status', timeout=30).read().decode())
    print('health:', health)
    print('installed:', status['installed_count'], 'missing:', status['missing_count'], 'total:', status['count'])
except Exception as e:
    print('http check failed:', e)
PY

echo "log: $LOG_FILE"
