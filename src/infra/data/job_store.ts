import { Pool } from "pg";
import { AppConfig } from "../../core/types.js";

export type AppJobStatus = "queued" | "running" | "completed" | "failed";

export interface AppJobRecord {
  id: string;
  status: AppJobStatus;
  createdAtUtc: string;
  startedAtUtc?: string;
  completedAtUtc?: string;
  target: string;
  normalizedType?: "domain" | "url" | "email";
  activeRecon: boolean;
  reconMode: "standard" | "aggressive";
  tlp: string;
  error?: string;
  result?: Record<string, unknown>;
  reportHtml?: string;
  evidenceJson?: Record<string, unknown>;
  auditJson?: unknown[];
}

function poolKeyFromConfig(config: AppConfig): string {
  if (config.supabase.postgresUrl) {
    return `supabase:${config.supabase.postgresUrl}`;
  }
  const host = config.pg.host ?? "";
  const port = String(config.pg.port ?? 5432);
  const user = config.pg.user ?? "";
  const db = config.pg.database ?? "";
  return `pg:${host}:${port}:${user}:${db}`;
}

const pools = new Map<string, Pool>();

function resolvePool(config: AppConfig): Pool | undefined {
  if (config.supabase.postgresUrl) {
    const key = poolKeyFromConfig(config);
    const existing = pools.get(key);
    if (existing) return existing;
    const pool = new Pool({
      connectionString: config.supabase.postgresUrl,
      ssl: { rejectUnauthorized: false },
      max: 5
    });
    pools.set(key, pool);
    return pool;
  }

  if (!config.pg.host || !config.pg.user || !config.pg.database) {
    return undefined;
  }

  const key = poolKeyFromConfig(config);
  const existing = pools.get(key);
  if (existing) return existing;

  const pool = new Pool({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    database: config.pg.database,
    ssl: config.pg.ssl ? { rejectUnauthorized: false } : undefined,
    max: 5
  });
  pools.set(key, pool);
  return pool;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function mapRow(row: Record<string, unknown>): AppJobRecord {
  const normalizedType = toOptionalString(row.normalized_type);
  return {
    id: String(row.id),
    status: String(row.status) as AppJobStatus,
    createdAtUtc: String(row.created_at),
    startedAtUtc: toOptionalString(row.started_at),
    completedAtUtc: toOptionalString(row.completed_at),
    target: String(row.target),
    normalizedType:
      normalizedType === "domain" || normalizedType === "url" || normalizedType === "email" ? normalizedType : undefined,
    activeRecon: Boolean(row.active_recon),
    reconMode: String(row.recon_mode) === "aggressive" ? "aggressive" : "standard",
    tlp: String(row.tlp),
    error: toOptionalString(row.error),
    result: (row.result as Record<string, unknown> | null) ?? undefined,
    reportHtml: toOptionalString(row.report_html),
    evidenceJson: (row.evidence_json as Record<string, unknown> | null) ?? undefined,
    auditJson: (row.audit_json as unknown[] | null) ?? undefined
  };
}

export class JobStore {
  private readonly pool?: Pool;
  private initialized = false;

  constructor(private readonly config: AppConfig) {
    this.pool = resolvePool(config);
  }

  isConfigured(): boolean {
    return Boolean(this.pool);
  }

  async init(): Promise<void> {
    if (!this.pool || this.initialized) {
      return;
    }
    await this.pool.query(`
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
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_app_jobs_created_at ON app_jobs(created_at DESC);`);
    this.initialized = true;
  }

  async create(job: AppJobRecord): Promise<void> {
    if (!this.pool) return;
    await this.init();
    await this.pool.query(
      `INSERT INTO app_jobs
        (id, status, created_at, started_at, completed_at, target, normalized_type, active_recon, recon_mode, tlp, error, result, report_html, evidence_json, audit_json)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        job.id,
        job.status,
        job.createdAtUtc,
        job.startedAtUtc ?? null,
        job.completedAtUtc ?? null,
        job.target,
        job.normalizedType ?? null,
        job.activeRecon,
        job.reconMode,
        job.tlp,
        job.error ?? null,
        job.result ? JSON.stringify(job.result) : null,
        job.reportHtml ?? null,
        job.evidenceJson ? JSON.stringify(job.evidenceJson) : null,
        job.auditJson ? JSON.stringify(job.auditJson) : null
      ]
    );
  }

  async update(jobId: string, patch: Partial<AppJobRecord>): Promise<void> {
    if (!this.pool) return;
    await this.init();

    await this.pool.query(
      `UPDATE app_jobs
       SET status = COALESCE($2, status),
           started_at = COALESCE($3, started_at),
           completed_at = COALESCE($4, completed_at),
           error = COALESCE($5, error),
           result = COALESCE($6, result),
           report_html = COALESCE($7, report_html),
           evidence_json = COALESCE($8, evidence_json),
           audit_json = COALESCE($9, audit_json)
       WHERE id = $1`,
      [
        jobId,
        patch.status ?? null,
        patch.startedAtUtc ?? null,
        patch.completedAtUtc ?? null,
        patch.error ?? null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.reportHtml ?? null,
        patch.evidenceJson ? JSON.stringify(patch.evidenceJson) : null,
        patch.auditJson ? JSON.stringify(patch.auditJson) : null
      ]
    );
  }

  async get(jobId: string): Promise<AppJobRecord | undefined> {
    if (!this.pool) return undefined;
    await this.init();
    const result = await this.pool.query(`SELECT * FROM app_jobs WHERE id = $1`, [jobId]);
    if (result.rowCount === 0) {
      return undefined;
    }
    return mapRow(result.rows[0] as Record<string, unknown>);
  }

  async list(limit = 50): Promise<AppJobRecord[]> {
    if (!this.pool) return [];
    await this.init();
    const capped = Math.min(Math.max(limit, 1), 200);
    const result = await this.pool.query(`SELECT * FROM app_jobs ORDER BY created_at DESC LIMIT $1`, [capped]);
    return result.rows.map((row) => mapRow(row as Record<string, unknown>));
  }
}
