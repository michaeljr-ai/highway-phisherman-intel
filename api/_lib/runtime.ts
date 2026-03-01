import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInvestigationInput, normalizeInput } from "../../src/core/normalize.js";
import { runInvestigation } from "../../src/core/orchestrator.js";
import { loadConfig } from "../../src/core/config.js";
import { getToolCoverageSnapshot } from "../../src/core/tool_manifest.js";
import { JobStore, SupabaseStore } from "../../src/infra/index.js";
import type { AppJobRecord } from "../../src/infra/data/job_store.js";

const config = loadConfig();
const jobStore = new JobStore(config);
const supabaseStore = new SupabaseStore(config);

let initPromise: Promise<void> | undefined;

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

export async function ensureRuntimeInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const coverage = getToolCoverageSnapshot();
      if (coverage.missingRequired.length > 0) {
        throw new Error(`Required tool adapters missing: ${coverage.missingRequired.join("; ")}`);
      }
      await Promise.allSettled([jobStore.init(), supabaseStore.init()]);
    })();
  }
  await initPromise;
}

async function emitJobEvent(params: {
  jobId: string;
  caseId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await supabaseStore.recordJobEvent({
    jobId: params.jobId,
    caseId: params.caseId,
    eventType: params.eventType,
    payload: params.payload
  });
}

export async function listJobs(): Promise<AppJobRecord[]> {
  await ensureRuntimeInitialized();
  return jobStore.list(50);
}

export async function getJob(jobId: string): Promise<AppJobRecord | undefined> {
  await ensureRuntimeInitialized();
  return jobStore.get(jobId);
}

export async function runJob(params: {
  target: string;
  tlp?: string;
  activeRecon?: boolean;
}): Promise<AppJobRecord> {
  await ensureRuntimeInitialized();

  const target = params.target.trim();
  const requestedTlp = params.tlp?.trim() || config.defaultTlp;
  const tlp = normalizeTlp(requestedTlp, config.defaultTlp);
  const reconMode = reconModeFromTlp(tlp);
  const requestedActiveRecon = params.activeRecon === undefined ? false : Boolean(params.activeRecon);
  const activeRecon = reconMode === "aggressive" ? true : requestedActiveRecon;

  const normalized = normalizeInput(target);
  if (!normalized.flags.isValid) {
    throw new Error(normalized.flags.validationError ?? "Invalid target");
  }
  if (!["domain", "url", "email"].includes(normalized.inputKind)) {
    throw new Error("Only domain, URL, and email are allowed inputs");
  }

  const jobId = randomUUID();
  const createdAtUtc = new Date().toISOString();
  const baseJob: AppJobRecord = {
    id: jobId,
    status: "queued",
    createdAtUtc,
    target,
    normalizedType: normalized.inputKind,
    activeRecon,
    reconMode,
    tlp
  };

  await jobStore.create(baseJob);
  await emitJobEvent({
    jobId,
    eventType: "job.queued",
    payload: {
      target,
      normalizedType: normalized.inputKind,
      activeRecon,
      reconMode,
      tlp
    }
  });

  const startedAtUtc = new Date().toISOString();
  await jobStore.update(jobId, {
    status: "running",
    startedAtUtc
  });
  await emitJobEvent({
    jobId,
    eventType: "job.running",
    payload: {
      target,
      startedAtUtc
    }
  });

  try {
    const input = createInvestigationInput([target], tlp);
    const result = await runInvestigation(input, config, { activeRecon, reconMode });

    const completedAtUtc = new Date().toISOString();
    const reportHtml = await fs.readFile(result.reportHtmlPath, "utf8");
    const evidenceJson = JSON.parse(await fs.readFile(result.evidenceJsonPath, "utf8")) as Record<string, unknown>;
    const auditJson = JSON.parse(await fs.readFile(result.auditJsonPath, "utf8")) as unknown[];

    const resultSummary: AppJobRecord["result"] = {
      caseId: result.caseId,
      severity: result.score.severity,
      score: result.score.total,
      confidencePct: result.score.confidencePct,
      toolRuns: result.enrichments.length
    };

    await jobStore.update(jobId, {
      status: "completed",
      completedAtUtc,
      result: resultSummary,
      reportHtml,
      evidenceJson,
      auditJson
    });

    await emitJobEvent({
      jobId,
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
    const message = error instanceof Error ? error.message : String(error);
    const completedAtUtc = new Date().toISOString();

    await jobStore.update(jobId, {
      status: "failed",
      completedAtUtc,
      error: message
    });

    await emitJobEvent({
      jobId,
      eventType: "job.failed",
      payload: {
        error: message
      }
    });
  }

  const finalJob = await jobStore.get(jobId);
  if (!finalJob) {
    throw new Error("Job persisted state unavailable after execution.");
  }
  return finalJob;
}

export function runtimeHealth(): Record<string, unknown> {
  return {
    ok: true,
    ts: new Date().toISOString(),
    app_env: config.appEnv,
    event_provider: config.eventing.provider,
    zero_trust_required: config.security.zeroTrustRequired,
    secrets_provider: config.security.secretsProvider
  };
}
