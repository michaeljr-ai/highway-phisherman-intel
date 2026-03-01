#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.vercel"

cd "$ROOT_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

required_vars=(
  VERCEL_TOKEN
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_POSTGRES_URL
)

missing=()
for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing required variables: ${missing[*]}" >&2
  echo "Set them in environment or $ENV_FILE and retry." >&2
  exit 1
fi

vercel deploy \
  --archive=tgz \
  --yes \
  --token "$VERCEL_TOKEN" \
  --env APP_ENV=production \
  --env OUTPUT_ROOT=/tmp/briefings \
  --env PRIVATE_MODE=false \
  --env RBAC_ENABLED=false \
  --env RBAC_REQUIRE_KEYS=false \
  --env PGSSL=true \
  --env SUPABASE_URL="$SUPABASE_URL" \
  --env SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  --env SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  --env SUPABASE_POSTGRES_URL="$SUPABASE_POSTGRES_URL"
