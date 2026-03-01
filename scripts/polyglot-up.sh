#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
cd "$ROOT_DIR"

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$ENV_FILE"
  if [[ ! -f "$file" ]]; then
    return
  fi
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} {if($0 ~ "^"k"="){print k"="v; done=1} else print $0} END{if(!done) print k"="v}' "$file" > "$tmp"
  else
    cat "$file" > "$tmp"
    printf '\n%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$file"
}

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
  CFG="$HOME/Library/Application Support/ngrok/ngrok.yml"
  if [[ -f "$CFG" ]]; then
    export NGROK_AUTHTOKEN="$(awk '/authtoken:/{print $2}' "$CFG" | tail -n 1)"
  fi
fi

if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "NGROK_AUTHTOKEN is required (export it or configure ngrok globally)." >&2
  exit 1
fi

export NGROK_AUTHTOKEN

if [[ -z "${RBAC_VIEWER_KEY:-}" ]]; then
  export RBAC_VIEWER_KEY="viewer-$(openssl rand -hex 8)"
  upsert_env RBAC_VIEWER_KEY "$RBAC_VIEWER_KEY"
fi
if [[ -z "${RBAC_ANALYST_KEY:-}" ]]; then
  export RBAC_ANALYST_KEY="analyst-$(openssl rand -hex 8)"
  upsert_env RBAC_ANALYST_KEY "$RBAC_ANALYST_KEY"
fi
if [[ -z "${RBAC_ADMIN_KEY:-}" ]]; then
  export RBAC_ADMIN_KEY="admin-$(openssl rand -hex 8)"
  upsert_env RBAC_ADMIN_KEY "$RBAC_ADMIN_KEY"
fi

if [[ -z "${RBAC_ROLE_KEYS_JSON:-}" ]]; then
  export RBAC_ROLE_KEYS_JSON="{\"viewer\":\"$RBAC_VIEWER_KEY\",\"analyst\":\"$RBAC_ANALYST_KEY\",\"admin\":\"$RBAC_ADMIN_KEY\"}"
  upsert_env RBAC_ROLE_KEYS_JSON "$RBAC_ROLE_KEYS_JSON"
fi

PRIVATE_MODE_VALUE="${PRIVATE_MODE:-false}"
if truthy "$PRIVATE_MODE_VALUE" && [[ -z "${OWNER_ACCESS_TOKEN:-}" ]]; then
  echo "PRIVATE_MODE=true requires OWNER_ACCESS_TOKEN in $ENV_FILE." >&2
  echo "Add a long random value, then re-run. Example:" >&2
  echo '  OWNER_ACCESS_TOKEN=$(openssl rand -hex 32)' >&2
  exit 1
fi

compose_args=(-f docker-compose.polyglot.yml)
if [[ -f "$ENV_FILE" ]]; then
  compose_args=(--env-file "$ENV_FILE" "${compose_args[@]}")
fi

docker compose "${compose_args[@]}" up --build -d

echo "Stack started. Waiting for ngrok tunnel..."
for _ in {1..30}; do
  payload="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null || true)"
  url="$(printf '%s' "$payload" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d||"{}");const t=(j.tunnels||[]).find(x=>x.proto==="https")||(j.tunnels||[])[0];if(t&&t.public_url)process.stdout.write(t.public_url);}catch{}})')"
  if [[ -n "$url" ]]; then
    echo "Public URL: $url"
    exit 0
  fi
  sleep 2
done

echo "ngrok URL not ready yet. Check: http://127.0.0.1:4040/api/tunnels"
