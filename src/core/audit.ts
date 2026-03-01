import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { AppConfig, AuditEvent } from "./types.js";
import { isPgConfigured } from "./config.js";

export class AuditLogger {
  private readonly events: AuditEvent[] = [];
  private readonly caseId: string;
  private readonly outputDir: string;
  private readonly config: AppConfig;
  private dbClient?: Client;
  private dbWriteQueue: Promise<void> = Promise.resolve();

  constructor(caseId: string, outputDir: string, config: AppConfig) {
    this.caseId = caseId;
    this.outputDir = outputDir;
    this.config = config;
  }

  async init(): Promise<void> {
    if (!isPgConfigured(this.config)) {
      return;
    }

    this.dbClient = this.config.supabase.postgresUrl
      ? new Client({
          connectionString: this.config.supabase.postgresUrl,
          ssl: { rejectUnauthorized: false }
        })
      : new Client({
          host: this.config.pg.host,
          port: this.config.pg.port,
          user: this.config.pg.user,
          password: this.config.pg.password,
          database: this.config.pg.database,
          ssl: this.config.pg.ssl ? { rejectUnauthorized: false } : undefined
        });

    try {
      await this.dbClient.connect();
      await this.dbClient.query(`
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
      `);
      await this.dbClient.query(`CREATE INDEX IF NOT EXISTS idx_intel_audit_case_id ON intel_audit_log(case_id);`);
    } catch {
      this.dbClient = undefined;
    }
  }

  async close(): Promise<void> {
    await this.dbWriteQueue.catch(() => undefined);
    if (this.dbClient) {
      await this.dbClient.end();
    }
  }

  private async enqueueDbWrite(task: () => Promise<void>): Promise<void> {
    this.dbWriteQueue = this.dbWriteQueue.then(task);
    return this.dbWriteQueue;
  }

  async log(event: Omit<AuditEvent, "tsUtc"> & { tsUtc?: string }): Promise<void> {
    const normalized: AuditEvent = {
      tsUtc: event.tsUtc ?? new Date().toISOString(),
      eventType: event.eventType,
      wave: event.wave,
      toolName: event.toolName,
      status: event.status,
      message: event.message,
      details: event.details
    };

    this.events.push(normalized);

    if (this.dbClient) {
      await this.enqueueDbWrite(async () => {
        if (!this.dbClient) return;
        await this.dbClient.query(
          `INSERT INTO intel_audit_log (case_id, ts, event_type, wave, tool_name, status, message, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.caseId,
            normalized.tsUtc,
            normalized.eventType,
            normalized.wave,
            normalized.toolName ?? null,
            normalized.status,
            normalized.message,
            JSON.stringify(normalized.details)
          ]
        );
      });
    }
  }

  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  async exportJson(): Promise<string> {
    const outputPath = path.join(this.outputDir, "audit_log.json");
    await fs.writeFile(outputPath, JSON.stringify(this.events, null, 2), "utf8");
    return outputPath;
  }
}
