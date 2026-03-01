CREATE TABLE IF NOT EXISTS app_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  target TEXT NOT NULL,
  normalized_type TEXT,
  active_recon BOOLEAN NOT NULL,
  recon_mode TEXT NOT NULL,
  tlp TEXT NOT NULL,
  error TEXT,
  result JSONB,
  report_html TEXT,
  evidence_json JSONB,
  audit_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_app_jobs_created_at ON app_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS app_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  case_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
