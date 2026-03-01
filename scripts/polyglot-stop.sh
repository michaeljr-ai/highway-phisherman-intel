#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/polyglot_host.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "polyglot-host is not running (no pid file)"
  exit 0
fi

pid="$(cat "$PID_FILE" || true)"
if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" || true
  fi
  echo "polyglot-host stopped (pid=$pid)"
else
  echo "polyglot-host was not running (stale pid=$pid)"
fi
rm -f "$PID_FILE"
