# Nexus MC/DOT Case Runner

Rust + PostgreSQL 18 pipeline for branch-to-carrier linkage in fraud investigations.

What it does:
- Ingests branch locations from [`case_data/us_bank_branches_az.csv`](case_data/us_bank_branches_az.csv).
- Pulls FMCSA registration data from dataset `az4n-8mr2` (DOT/MC + physical/mailing addresses).
- Scores address matches and writes direct branch -> DOT/MC links.
- Optionally runs Nexus scans (`/api/scan`) and extracts DOT/MC identifiers from every tool output.
- Validates candidate DOT/MC values against SAFER snapshot lookups.
- Discovers env/API credential keys across your workspace and stores key inventory (without secret values).
- Discovers highway/freight/transport CSV files and extracts DOT/MC evidence rows.
- Stores full evidence in PostgreSQL 18 and exports CSV/JSON outputs.

## Files

- `src/main.rs`: main case runner
- `sql/schema.sql`: PostgreSQL schema + views
- `case_data/us_bank_branches_az.csv`: provided US Bank branch list
- `output/direct_links.csv`: exported linkage rows
- `output/summary.json`: run summary
- `output/api_inventory.csv`: discovered API/env key inventory
- `output/external_csv_hits.csv`: DOT/MC hits from discovered CSV intelligence files
- `output/api_health_check.txt`: live API health probe output
- `postman/`: Postman.app cyber/OSINT workspace kit (collections, environments, Newman scripts)
- `caido/`: Caido CyberDeck bundle (plugin, workflows, theme, automation scripts)

## Prerequisites

1. PostgreSQL 18 server running (example uses port `5433`):

```bash
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /opt/homebrew/var/postgresql@18 -l /tmp/postgresql18.log -o "-p 5433" start
```

2. (Optional but recommended for full-tool ingestion) Nexus API running on `127.0.0.1:8090`:

```bash
cd /Users/michaelcaneyjr/NEXUS
python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 8090
```

## Run

Full run with Nexus enabled:

```bash
cargo run --release -- \
  --admin-database-url postgres://localhost:5433/postgres \
  --case-database-name wire_fraud_mc_dot_case \
  --nexus-enabled true \
  --discovery-root /Users/michaelcaneyjr \
  --discovery-max-depth 6
```

Fast run (FMCSA linkage only, no Nexus scan wait):

```bash
cargo run --release -- \
  --admin-database-url postgres://localhost:5433/postgres \
  --case-database-name wire_fraud_mc_dot_case \
  --nexus-enabled false \
  --discovery-root /Users/michaelcaneyjr \
  --discovery-max-depth 6
```

Limited smoke test:

```bash
cargo run -- --max-branches 1 --nexus-enabled true
```

## Useful SQL

Open psql:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql -p 5433 -d wire_fraud_mc_dot_case
```

Direct high-confidence links:

```sql
SELECT * FROM v_branch_direct_links;
```

Unverified extracted identifiers:

```sql
SELECT * FROM v_unverified_candidates;
```

Per-tool coverage:

```sql
SELECT * FROM v_tool_coverage;
```

## Claude Limit Shield

Local wrapper to reduce `prompt too long` and `429` interruptions by:
- compressing long inputs automatically,
- compressing older chat turns into rolling memory,
- pacing requests and retrying with exponential backoff.

It does **not** bypass Anthropic hard limits; it keeps requests within them.

```bash
export ANTHROPIC_API_KEY="your_key"
./scripts/run_claude_shield.sh
```

Global launcher (already linked):

```bash
claude-smart
```

One-shot prompt:

```bash
./scripts/run_claude_shield.sh --prompt "Summarize this file..."
```

State is persisted at `~/.claude-limit-shield/chat_state.json`.

---

## Overkill Domain + Email + URL Intel Briefing Generator (Node + TypeScript)

This repository now also contains a strict-scope OSINT briefing generator that only accepts `domain`, `url`, and `email` inputs, with derived entities limited to:
- IPs from DNS/passive sources
- usernames from email local-part/discovered handles
- phone numbers only when already present in collected artifacts (or explicitly provided)

### Scope-Safe Output Bundle

Per case run, the generator exports:
- `report.html` (self-contained Palantir-style highway-themed briefing)
- `evidence.json` (artifact index with SHA-256 hashes)
- `artifacts/` (raw + parsed + error artifacts)
- `audit_log.json` (ordered chain-of-custody events)

### Project Structure

- `src/core/`
  - normalization, orchestration, fusion, graph, scoring, IOC extraction, artifacts, audit
- `src/enrichers/`
  - adapters for all 55 requested tools/data sources (+ dedicated DNS records adapter)
- `src/report/`
  - HTML template + generator + export pipeline
- `tests/`
  - normalization, parsers, IOC extraction, scoring, graph tests
- `sql/intel_briefing_schema.sql`
  - PostgreSQL schema for cases, artifacts, and audit log

### Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Initialize PostgreSQL schema (required for production chain-of-custody persistence):

```bash
psql "$DATABASE_URL" -f sql/intel_briefing_schema.sql
```

(Or map `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` via `.env`.)

### Run

Web app (recommended):

```bash
npm start
```

Then open:
- `http://localhost:4010`
- Enter one domain, URL, or email and click **Run Investigation**.

### Vercel + Supabase Deployment

This repo now supports serverless deployment on Vercel with Supabase Postgres persistence.

1. Ensure schema is present in Supabase:

```bash
psql "$SUPABASE_POSTGRES_URL" -f sql/intel_briefing_schema.sql
psql "$SUPABASE_POSTGRES_URL" -f sql/vercel_jobs_schema.sql
```

2. Set Vercel env vars (minimum):

- `APP_ENV=production`
- `OUTPUT_ROOT=/tmp/briefings`
- `PRIVATE_MODE=false`
- `RBAC_ENABLED=false`
- `RBAC_REQUIRE_KEYS=false`
- `PGSSL=true`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_POSTGRES_URL`

You can place these in `.env.vercel` (template: `.env.vercel.example`).

3. Deploy preview:

```bash
npm run deploy:vercel:supabase
```

Runtime notes:
- Static UI is served from `public/`.
- API is served from `api/` routes (`/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/report`, `/api/jobs/:id/evidence`, `/api/health`).
- Job state and outputs are stored in Supabase (`app_jobs`, `app_job_events`), so report/evidence survive serverless restarts.

### Original Prompt Scope + Tool Coverage

- Scope is hard-limited to `domain`, `url`, and `email` inputs.
- Tool adapters are coverage-checked at startup (`55` required adapters present; server boot fails if any are missing).
- Out-of-scope adapters (carrier/census/internal mapping) remain implemented but disabled unless explicitly provided in-scope discovered inputs.

### ngrok Integration

1. Start the full polyglot stack:

```bash
npm run polyglot:up
```

2. Get the current public URL:

```bash
npm run tunnel:url
```

3. Access securely with owner token bootstrap (sets `HttpOnly` cookie):

```bash
https://<ngrok-url>/?owner_token=<OWNER_ACCESS_TOKEN>
```

4. In the UI, set role (`analyst` recommended) and key (`RBAC_ANALYST_KEY`).

### Always-On (macOS launchd)

Install persistent background services (app + ngrok):

```bash
npm run always-on:install
```

Check status:

```bash
npm run always-on:status
```

Uninstall services:

```bash
npm run always-on:uninstall
```

### Public Website (Polyglot Backend)

This repo now includes a polyglot risk backend:
- `services/rails-gateway` (Ruby on Rails API gateway)
- `services/rust-bayes` (Rust Bayesian risk engine)
- `services/haskell-signal` (Haskell signal engine)

Bring up full stack + ngrok (public URL) with Docker Compose:

```bash
npm run polyglot:up
```

Stop stack:

```bash
npm run polyglot:down
```

Always-on polyglot stack (launchd):

```bash
npm run polyglot:always-on:install
npm run polyglot:always-on:status
```

Remove always-on polyglot stack:

```bash
npm run polyglot:always-on:uninstall
```

CLI mode (single-run pipeline):

```bash
npm run cli -- \
  --input example.com \
  --input https://example.com/login?x=1 \
  --input user@example.com \
  --active=false
```

Mocked CLI run:

```bash
npm run mock
```

Output appears under:
- `output/briefings/<CASE_ID>/`

### Edge/Infra Stack

- Cloudflare (Workers + WAF + R2 + Queues): `cloudflare/worker/`
- Fly.io (containerized risk engines): `fly/risk-engine/`
- Supabase Postgres sink: `src/infra/data/supabase_store.ts`
- Neo4j Aura sink: `src/infra/graph/neo4j_aura.ts`
- Event bus abstraction (Kafka/Redpanda/Cloudflare Queues): `src/infra/events/event_bus.ts`
- OpenTelemetry bootstrap + Grafana collector templates: `src/infra/observability/telemetry.ts`, `infra/observability/`
- Strict RBAC + hardware-backed secrets policy + Zero Trust gate: `src/infra/security/`

### Active/Passive toggles

- Active recon (Wave 4):
  - pass `--active=true`
- Heavy passive CLI recon (disabled by default):
  - set `PASSIVE_CLI_RECON_ENABLED=true`

### Environment Variables

Core:
- `OUTPUT_ROOT`, `DEFAULT_TLP`
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSL`
- `OWNER_ACCESS_TOKEN` (required when `PRIVATE_MODE=true`)
- `RBAC_VIEWER_KEY`, `RBAC_ANALYST_KEY`, `RBAC_ADMIN_KEY`
- `PRIVATE_MODE`, `RBAC_ENABLED`, `RBAC_REQUIRE_KEYS`, `ZERO_TRUST_REQUIRED`
- `ALLOWLIST_IPS`, `REQUEST_LIMIT_PER_MINUTE`, `SENSITIVE_REQUEST_LIMIT_PER_MINUTE`
- `ALLOWED_ORIGINS`, `SECRETS_PROVIDER`

Tool keys (optional; missing keys render structured `not_configured` sections):
- `SHODAN_API_KEY`
- `VIRUSTOTAL_API_KEY`
- `HUNTER_API_KEY`
- `ABUSEIPDB_API_KEY`
- `SCAMALYTICS_API_KEY`
- `IPQS_API_KEY`
- `VERIPHONE_API_KEY`
- `GREIP_API_KEY`
- `IPSTACK_API_KEY`
- `IPGEOLOCATION_API_KEY`
- `CENSYS_API_ID`, `CENSYS_API_SECRET`
- `URLSCAN_API_KEY`
- `HOSTIO_API_KEY`
- `STOPFORUMSPAM_API_KEY`
- `GITHUB_TOKEN`
- `NUMVERIFY_API_KEY`
- `MAXMIND_LICENSE_KEY`

Optional user-provided appendix/mapping inputs:
- `CSV_ARTIFACT_PATH`
- `METHODOLOGY_DOC_PATH`
- `BMO_DOCKET_INPUT`
- `FMCSA_IP_MAPPING_FILE`
