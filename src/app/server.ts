import express from "express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { createInvestigationInput, normalizeInput } from "../core/normalize.js";
import { runInvestigation } from "../core/orchestrator.js";
import { getToolCoverageSnapshot } from "../core/tool_manifest.js";
import {
  assertSecurityPolicy,
  createEventBus,
  FlyRiskEngineClient,
  globalRateLimitMiddleware,
  ipAllowlistMiddleware,
  Neo4jAuraSink,
  ownerOnlyMiddleware,
  PolyglotRiskGatewayClient,
  R2Mirror,
  requirePermission,
  securityHeadersMiddleware,
  sensitiveRateLimitMiddleware,
  startTelemetry,
  stopTelemetry,
  SupabaseStore,
  withSpan
} from "../infra/index.js";

type JobStatus = "queued" | "running" | "completed" | "failed";

interface AppJob {
  id: string;
  status: JobStatus;
  createdAtUtc: string;
  startedAtUtc?: string;
  completedAtUtc?: string;
  target: string;
  normalizedType?: "domain" | "url" | "email";
  activeRecon: boolean;
  reconMode: "standard" | "aggressive";
  tlp: string;
  error?: string;
  result?: {
    caseId: string;
    severity: string;
    score: number;
    confidencePct: number;
    reportHtmlPath: string;
    evidenceJsonPath: string;
    auditJsonPath: string;
    toolRuns: number;
    flyRiskEngine?: Record<string, unknown> | null;
    railsPolyglotRisk?: Record<string, unknown> | null;
  };
}

function normalizeTlp(value: string, fallback: string): string {
  const normalized = value.trim().toUpperCase();
  if (["TLP:RED", "TLP:AMBER", "TLP:GREEN", "TLP:CLEAR"].includes(normalized)) {
    return normalized;
  }
  return fallback.toUpperCase();
}

function reconModeFromTlp(tlp: string): "standard" | "aggressive" {
  return tlp === "TLP:RED" ? "aggressive" : "standard";
}

const jobs = new Map<string, AppJob>();
const config = loadConfig();
const eventBus = createEventBus(config);
const supabaseStore = new SupabaseStore(config);
const neo4jSink = new Neo4jAuraSink(config);
const r2Mirror = new R2Mirror(config);
const flyRiskEngine = new FlyRiskEngineClient(config);
const polyglotRiskGateway = new PolyglotRiskGatewayClient(config);

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "public");

app.use(securityHeadersMiddleware());
app.use(ownerOnlyMiddleware(config));
app.use(ipAllowlistMiddleware(config));
app.use(globalRateLimitMiddleware(config));
app.use(express.json({ limit: "256kb" }));

function routeId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

async function emitJobEvent(params: {
  jobId: string;
  caseId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const event = {
    type: params.eventType,
    tsUtc: new Date().toISOString(),
    jobId: params.jobId,
    caseId: params.caseId,
    payload: params.payload
  };

  await Promise.allSettled([
    eventBus.publish(event),
    supabaseStore.recordJobEvent({
      jobId: params.jobId,
      caseId: params.caseId,
      eventType: params.eventType,
      payload: params.payload
    })
  ]);
}

app.get("/health", requirePermission(config, "health:read"), (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    app_env: config.appEnv,
    event_provider: config.eventing.provider,
    zero_trust_required: config.security.zeroTrustRequired,
    secrets_provider: config.security.secretsProvider
  });
});

app.get("/api/jobs", requirePermission(config, "jobs:read"), (_req, res) => {
  const all = Array.from(jobs.values())
    .sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1))
    .slice(0, 50);
  res.json({ jobs: all });
});

app.get("/api/jobs/:id", requirePermission(config, "jobs:read"), (req, res) => {
  const job = jobs.get(routeId(req.params.id));
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  return res.json({ job });
});

app.get(
  "/api/jobs/:id/report",
  sensitiveRateLimitMiddleware(config),
  requirePermission(config, "artifacts:read"),
  async (req, res) => {
  const job = jobs.get(routeId(req.params.id));
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "completed" || !job.result) {
    return res.status(409).json({ error: "Report not ready" });
  }

  try {
    await fs.access(job.result.reportHtmlPath);
    return res.sendFile(job.result.reportHtmlPath);
  } catch {
    return res.status(404).json({ error: "Report file missing" });
  }
});

app.get(
  "/api/jobs/:id/evidence",
  sensitiveRateLimitMiddleware(config),
  requirePermission(config, "artifacts:read"),
  async (req, res) => {
  const job = jobs.get(routeId(req.params.id));
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "completed" || !job.result) {
    return res.status(409).json({ error: "Evidence not ready" });
  }

  try {
    const raw = await fs.readFile(job.result.evidenceJsonPath, "utf8");
    return res.type("application/json").send(raw);
  } catch {
    return res.status(404).json({ error: "Evidence file missing" });
  }
});

app.post("/api/jobs", sensitiveRateLimitMiddleware(config), requirePermission(config, "jobs:create"), async (req, res) => {
  const target = typeof req.body?.target === "string" ? req.body.target.trim() : "";
  const requestedTlp =
    typeof req.body?.tlp === "string" && req.body.tlp.trim() ? req.body.tlp.trim() : config.defaultTlp;
  const tlp = normalizeTlp(requestedTlp, config.defaultTlp);
  const requestedActiveRecon = req.body?.activeRecon === undefined ? true : Boolean(req.body?.activeRecon);
  const reconMode = reconModeFromTlp(tlp);
  const activeRecon = reconMode === "aggressive" ? true : requestedActiveRecon;

  if (!target) {
    return res.status(400).json({ error: "target is required (domain, URL, or email)" });
  }

  const normalized = normalizeInput(target);
  if (!normalized.flags.isValid) {
    return res.status(400).json({ error: normalized.flags.validationError ?? "Invalid target" });
  }

  if (![
    "domain",
    "url",
    "email"
  ].includes(normalized.inputKind)) {
    return res.status(400).json({ error: "Only domain, URL, and email are allowed inputs" });
  }

  const id = randomUUID();
  const job: AppJob = {
    id,
    status: "queued",
    createdAtUtc: new Date().toISOString(),
    target,
    normalizedType: normalized.inputKind,
    activeRecon,
    reconMode,
    tlp
  };
  jobs.set(id, job);

  await emitJobEvent({
    jobId: id,
    eventType: "job.queued",
    payload: {
      target,
      normalizedType: normalized.inputKind,
      activeRecon,
      reconMode,
      tlp
    }
  });

  setImmediate(async () => {
    const running = jobs.get(id);
    if (!running) {
      return;
    }

    running.status = "running";
    running.startedAtUtc = new Date().toISOString();

    await emitJobEvent({
      jobId: id,
      eventType: "job.running",
      payload: {
        target,
        startedAtUtc: running.startedAtUtc
      }
    });

    try {
      const input = createInvestigationInput([target], tlp);
      const result = await withSpan("investigation.run", () => runInvestigation(input, config, { activeRecon, reconMode }));

      const flyScore = await withSpan("risk-engine.fly", () =>
        flyRiskEngine.evaluate({
          caseId: result.caseId,
          target,
          enrichments: result.enrichments.length
        })
      ).catch((error) => {
        console.warn("Fly risk engine unavailable:", error);
        return null;
      });

      const railsPolyglotRisk = await withSpan("risk-engine.rails-polyglot", () =>
        polyglotRiskGateway.assess({
          target,
          evidence: result.keyLinkages.map((item) => item.text).slice(0, 20),
          indicators: {
            criticalSeverity: result.score.severity === "CRITICAL",
            activeReconEnabled: activeRecon,
            hasCertReuseSignal: result.score.breakdown.some((b) => b.signalId === "cert_reuse")
          }
        })
      ).catch((error) => {
        console.warn("Rails polyglot risk unavailable:", error);
        return null;
      });

      await Promise.allSettled([
        neo4jSink.upsertJobCase({
          jobId: id,
          caseId: result.caseId,
          target,
          inputType: normalized.inputKind,
          severity: result.score.severity,
          score: result.score.total
        }),
        r2Mirror.mirrorBundle({
          caseId: result.caseId,
          reportHtmlPath: result.reportHtmlPath,
          evidenceJsonPath: result.evidenceJsonPath,
          auditJsonPath: result.auditJsonPath
        })
      ]);

      running.status = "completed";
      running.completedAtUtc = new Date().toISOString();
      running.result = {
        caseId: result.caseId,
        severity: result.score.severity,
        score: result.score.total,
        confidencePct: result.score.confidencePct,
        reportHtmlPath: result.reportHtmlPath,
        evidenceJsonPath: result.evidenceJsonPath,
        auditJsonPath: result.auditJsonPath,
        toolRuns: result.enrichments.length,
        flyRiskEngine: flyScore,
        railsPolyglotRisk
      };

      await emitJobEvent({
        jobId: id,
        caseId: result.caseId,
        eventType: "job.completed",
        payload: {
          severity: result.score.severity,
          score: result.score.total,
          confidencePct: result.score.confidencePct,
          toolRuns: result.enrichments.length
        }
      });
    } catch (error) {
      running.status = "failed";
      running.completedAtUtc = new Date().toISOString();
      running.error = error instanceof Error ? error.message : String(error);

      await emitJobEvent({
        jobId: id,
        eventType: "job.failed",
        payload: {
          error: running.error
        }
      });
    }
  });

  return res.status(202).json({ job });
});

app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT ?? 4010);

async function shutdown(): Promise<void> {
  await Promise.allSettled([eventBus.shutdown(), supabaseStore.close(), neo4jSink.close(), stopTelemetry()]);
}

async function bootstrap(): Promise<void> {
  assertSecurityPolicy(config);
  const coverage = getToolCoverageSnapshot();
  if (coverage.missingRequired.length > 0) {
    throw new Error(`Required tool adapters missing: ${coverage.missingRequired.join("; ")}`);
  }
  await fs.mkdir(config.outputRoot, { recursive: true });
  await startTelemetry(config);
  await supabaseStore.init().catch(() => undefined);

  const server = app.listen(port, () => {
    console.log(`Highway Phisherman listening on http://localhost:${port}`);
    console.log(`Edge infra: Cloudflare + Fly integration enabled via config`);
    console.log(`Tool coverage: ${coverage.requiredCount}/${coverage.requiredCount} required, ${coverage.implementedCount} total`);
  });

  const closeHandler = async () => {
    server.close();
    await shutdown();
    process.exit(0);
  };

  process.on("SIGINT", closeHandler);
  process.on("SIGTERM", closeHandler);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
