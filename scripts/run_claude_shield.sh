#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$SOURCE_DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/anthropic_limit_shield.py"

if [[ ! -f "$PY_SCRIPT" ]]; then
  echo "Missing $PY_SCRIPT" >&2
  exit 1
fi

exec python3 "$PY_SCRIPT" \
  --model "${CLAUDE_MODEL:-claude-sonnet-4-6}" \
  --max-input-tokens "${CLAUDE_MAX_INPUT_TOKENS:-140000}" \
  --max-output-tokens "${CLAUDE_MAX_OUTPUT_TOKENS:-4096}" \
  --requests-per-minute "${CLAUDE_RPM:-8}" \
  ${CLAUDE_INSECURE_SSL:+--allow-insecure-ssl} \
  "$@"
