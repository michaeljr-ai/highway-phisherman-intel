CREATE TABLE IF NOT EXISTS intel_cases (
  case_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  tlp TEXT NOT NULL,
  inputs JSONB NOT NULL,
  metadata JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS intel_artifacts (
  artifact_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES intel_cases(case_id),
  tool_name TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  collection_method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  endpoint TEXT,
  tool_version TEXT,
  metadata JSONB NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS intel_audit_log (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES intel_cases(case_id),
  ts TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  wave INTEGER,
  tool_name TEXT,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intel_artifacts_case_id ON intel_artifacts(case_id);
CREATE INDEX IF NOT EXISTS idx_intel_audit_case_id ON intel_audit_log(case_id);
