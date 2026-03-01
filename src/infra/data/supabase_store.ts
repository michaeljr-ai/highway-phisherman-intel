import { Client } from "pg";
import { AppConfig } from "../../core/types.js";

export class SupabaseStore {
  private readonly client?: Client;
  private initialized = false;

  constructor(config: AppConfig) {
    const connectionString = config.supabase.postgresUrl;
    if (connectionString) {
      this.client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }
      });
      return;
    }

    if (config.pg.host && config.pg.user && config.pg.database) {
      this.client = new Client({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
        ssl: config.pg.ssl ? { rejectUnauthorized: false } : undefined
      });
    }
  }

  async init(): Promise<void> {
    if (!this.client || this.initialized) {
      return;
    }

    await this.client.connect();
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS app_job_events (
        id BIGSERIAL PRIMARY KEY,
        job_id TEXT NOT NULL,
        case_id TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    this.initialized = true;
  }

  async recordJobEvent(params: {
    jobId: string;
    caseId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.client) {
      return;
    }

    if (!this.initialized) {
      await this.init();
    }

    await this.client.query(
      `INSERT INTO app_job_events (job_id, case_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [params.jobId, params.caseId ?? null, params.eventType, JSON.stringify(params.payload)]
    );
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.client.end();
  }
}
