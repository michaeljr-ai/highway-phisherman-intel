CREATE TABLE IF NOT EXISTS case_run (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  branch_count INTEGER NOT NULL DEFAULT 0,
  nexus_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS branch (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  street TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  routing_number TEXT,
  normalized_street TEXT NOT NULL,
  normalized_city TEXT NOT NULL,
  UNIQUE (case_id, branch_name, street, city, state, zip)
);

CREATE INDEX IF NOT EXISTS idx_branch_case ON branch(case_id);
CREATE INDEX IF NOT EXISTS idx_branch_norm ON branch(normalized_city, normalized_street);

CREATE TABLE IF NOT EXISTS fmcsa_dataset_match (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  source_dataset TEXT NOT NULL,
  dot_number TEXT,
  mc_number TEXT,
  legal_name TEXT,
  matched_on TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL,
  phy_street TEXT,
  phy_city TEXT,
  phy_state TEXT,
  phy_zip TEXT,
  mailing_street TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  row_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fmcsa_match_branch ON fmcsa_dataset_match(branch_id);
CREATE INDEX IF NOT EXISTS idx_fmcsa_match_dot ON fmcsa_dataset_match(dot_number);
CREATE INDEX IF NOT EXISTS idx_fmcsa_match_mc ON fmcsa_dataset_match(mc_number);

CREATE TABLE IF NOT EXISTS nexus_scan (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_type TEXT,
  input_value TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  scan_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, branch_id, scan_id)
);

CREATE INDEX IF NOT EXISTS idx_nexus_scan_branch ON nexus_scan(branch_id);

CREATE TABLE IF NOT EXISTS nexus_tool_result (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT,
  category TEXT,
  duration_seconds DOUBLE PRECISION,
  summary TEXT,
  error_message TEXT,
  parsed_data JSONB,
  raw_output TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_tool_result_scan ON nexus_tool_result(scan_id);
CREATE INDEX IF NOT EXISTS idx_nexus_tool_result_tool ON nexus_tool_result(tool_name);

CREATE TABLE IF NOT EXISTS identifier_candidate (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  scan_id TEXT,
  source_tool TEXT,
  id_type TEXT NOT NULL CHECK (id_type IN ('DOT', 'MC')),
  id_value TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL,
  evidence_excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identifier_candidate_case ON identifier_candidate(case_id, id_type, id_value);

CREATE TABLE IF NOT EXISTS safer_validation (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL CHECK (id_type IN ('DOT', 'MC')),
  id_value TEXT NOT NULL,
  found BOOLEAN NOT NULL,
  dot_number TEXT,
  mc_number TEXT,
  legal_name TEXT,
  usdot_status TEXT,
  carrier_operation TEXT,
  validation_payload JSONB,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, id_type, id_value)
);

CREATE INDEX IF NOT EXISTS idx_safer_validation_dot ON safer_validation(dot_number);
CREATE INDEX IF NOT EXISTS idx_safer_validation_mc ON safer_validation(mc_number);

CREATE TABLE IF NOT EXISTS branch_dot_mc_link (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  dot_number TEXT,
  mc_number TEXT,
  legal_name TEXT,
  source_kind TEXT NOT NULL,
  source_tool TEXT,
  confidence NUMERIC(5,4) NOT NULL,
  evidence TEXT,
  evidence_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_link_branch ON branch_dot_mc_link(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_link_dot ON branch_dot_mc_link(dot_number);
CREATE INDEX IF NOT EXISTS idx_branch_link_mc ON branch_dot_mc_link(mc_number);

CREATE TABLE IF NOT EXISTS api_credential_inventory (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  key_name TEXT NOT NULL,
  has_value BOOLEAN NOT NULL,
  value_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_inventory_case ON api_credential_inventory(case_id);
CREATE INDEX IF NOT EXISTS idx_api_inventory_key ON api_credential_inventory(key_name);

CREATE TABLE IF NOT EXISTS external_csv_hit (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES case_run(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  row_number BIGINT NOT NULL,
  id_type TEXT CHECK (id_type IN ('DOT', 'MC')),
  id_value TEXT,
  carrier_name TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  address TEXT,
  confidence NUMERIC(5,4) NOT NULL,
  row_excerpt TEXT,
  row_payload JSONB,
  linked_branch_id BIGINT REFERENCES branch(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_csv_hit_case ON external_csv_hit(case_id);
CREATE INDEX IF NOT EXISTS idx_external_csv_hit_id ON external_csv_hit(id_type, id_value);

CREATE OR REPLACE VIEW v_branch_direct_links AS
SELECT
  b.id AS branch_id,
  b.branch_name,
  b.street,
  b.city,
  b.state,
  b.zip,
  l.dot_number,
  l.mc_number,
  l.legal_name,
  l.source_kind,
  l.source_tool,
  l.confidence,
  l.evidence,
  l.created_at
FROM branch_dot_mc_link l
JOIN branch b ON b.id = l.branch_id
WHERE l.confidence >= 0.90
ORDER BY l.confidence DESC, b.city, b.street;

CREATE OR REPLACE VIEW v_unverified_candidates AS
SELECT
  c.branch_id,
  b.street,
  b.city,
  b.state,
  c.id_type,
  c.id_value,
  c.source_tool,
  c.confidence,
  c.evidence_excerpt,
  c.created_at
FROM identifier_candidate c
JOIN branch b ON b.id = c.branch_id
LEFT JOIN safer_validation v
  ON v.case_id = c.case_id
 AND v.id_type = c.id_type
 AND v.id_value = c.id_value
WHERE COALESCE(v.found, FALSE) = FALSE
ORDER BY c.confidence DESC, c.created_at DESC;

CREATE OR REPLACE VIEW v_tool_coverage AS
SELECT
  case_id,
  tool_name,
  status,
  COUNT(*) AS executions
FROM nexus_tool_result
GROUP BY case_id, tool_name, status
ORDER BY tool_name, status;
