import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { AppConfig, CollectionMethod, EvidenceArtifact } from "./types.js";
import { isPgConfigured } from "./config.js";

function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8");
  }
  return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
}

function contentTypeFor(type: EvidenceArtifact["artifactType"]): string {
  switch (type) {
    case "xml":
      return "application/xml";
    case "json":
    case "parsed":
      return "application/json";
    case "image":
      return "image/png";
    default:
      return "text/plain";
  }
}

export class ArtifactStore {
  private readonly caseId: string;
  private readonly outputDir: string;
  private readonly artifactsDir: string;
  private readonly runTag: string;
  private readonly config: AppConfig;
  private readonly items: EvidenceArtifact[] = [];
  private dbClient?: Client;
  private dbWriteQueue: Promise<void> = Promise.resolve();

  constructor(caseId: string, outputDir: string, config: AppConfig) {
    this.caseId = caseId;
    this.outputDir = outputDir;
    this.artifactsDir = path.join(outputDir, "artifacts");
    this.runTag = crypto.randomUUID().slice(0, 8);
    this.config = config;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.artifactsDir, { recursive: true });

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
        CREATE TABLE IF NOT EXISTS intel_cases (
          case_id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          tlp TEXT NOT NULL,
          inputs JSONB NOT NULL,
          metadata JSONB NOT NULL
        );
      `);
      await this.dbClient.query(`
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
      `);
      await this.dbClient.query(`CREATE INDEX IF NOT EXISTS idx_intel_artifacts_case_id ON intel_artifacts(case_id);`);
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

  async putArtifact(params: {
    toolName: string;
    artifactType: EvidenceArtifact["artifactType"];
    payload: unknown;
    collectionMethod: CollectionMethod;
    endpoint?: string;
    toolVersion?: string;
    metadata?: Record<string, unknown>;
    extension?: string;
  }): Promise<EvidenceArtifact> {
    const buffer = toBuffer(params.payload);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const artifactId = `${this.caseId}-${this.runTag}-${params.toolName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-${this.items.length + 1}`;
    const ext = params.extension ?? inferExtension(params.artifactType, params.payload);
    const filePath = path.join(this.artifactsDir, `${artifactId}.${ext}`);

    await fs.writeFile(filePath, buffer);

    const artifact: EvidenceArtifact = {
      artifactId,
      caseId: this.caseId,
      toolName: params.toolName,
      artifactType: params.artifactType,
      collectionMethod: params.collectionMethod,
      createdAtUtc: new Date().toISOString(),
      endpoint: params.endpoint,
      toolVersion: params.toolVersion,
      filePath,
      sha256,
      contentType: contentTypeFor(params.artifactType),
      sizeBytes: buffer.byteLength,
      metadata: params.metadata ?? {}
    };

    this.items.push(artifact);

    if (this.dbClient) {
      await this.enqueueDbWrite(async () => {
        if (!this.dbClient) return;
        await this.dbClient.query(
          `INSERT INTO intel_artifacts
          (artifact_id, case_id, tool_name, artifact_type, collection_method, created_at, file_path, sha256, endpoint, tool_version, metadata, content_type, size_bytes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            artifact.artifactId,
            artifact.caseId,
            artifact.toolName,
            artifact.artifactType,
            artifact.collectionMethod,
            artifact.createdAtUtc,
            artifact.filePath,
            artifact.sha256,
            artifact.endpoint ?? null,
            artifact.toolVersion ?? null,
            JSON.stringify(artifact.metadata),
            artifact.contentType,
            artifact.sizeBytes
          ]
        );
      });
    }

    return artifact;
  }

  getAll(): EvidenceArtifact[] {
    return [...this.items];
  }

  async exportIndex(extra: Record<string, unknown> = {}): Promise<string> {
    const outputPath = path.join(this.outputDir, "evidence.json");
    const payload = {
      case_id: this.caseId,
      generated_at_utc: new Date().toISOString(),
      artifact_count: this.items.length,
      artifacts: this.items,
      ...extra
    };
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
    return outputPath;
  }
}

function inferExtension(type: EvidenceArtifact["artifactType"], payload: unknown): string {
  if (type === "xml") {
    return "xml";
  }
  if (type === "image") {
    return "png";
  }
  if (type === "json" || type === "parsed") {
    return "json";
  }
  if (typeof payload === "string" && payload.trim().startsWith("{")) {
    return "json";
  }
  return "txt";
}
