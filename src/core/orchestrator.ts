import { promises as fs } from "node:fs";
import path from "node:path";
import { resolve4, resolve6 } from "node:dns/promises";
import { Client } from "pg";
import { ArtifactStore } from "./artifacts.js";
import { AuditLogger } from "./audit.js";
import { isPgConfigured } from "./config.js";
import { fuseFindings } from "./fusion.js";
import { deriveScopeFromFindings, extractIocsFromText } from "./ioc_extract.js";
import { computeRiskScore } from "./scoring.js";
import { fetchJson, fetchText, runCommand } from "./utils.js";
import { buildToolReadinessReport } from "./tool_readiness.js";
import { ENRICHERS_BY_WAVE, TOOL_COUNT } from "../enrichers/registry.js";
import {
  AppConfig,
  EnricherAdapter,
  EnricherContext,
  EnricherOutput,
  InvestigationInput,
  InvestigationResult,
  ScopeState
} from "./types.js";
import { generateReportHtml } from "../report/generator.js";
import { exportBundle } from "../report/export.js";

function initScope(input: InvestigationInput): ScopeState {
  const scope: ScopeState = {
    domains: new Set<string>(),
    urls: new Set<string>(),
    emails: new Set<string>(),
    ips: new Set<string>(),
    usernames: new Set<string>(),
    phones: new Set<string>(),
    certFingerprints: new Set<string>(),
    findings: {}
  };

  for (const item of input.normalizedInputs) {
    if (!item.flags.isValid) {
      continue;
    }

    if (item.rootDomain) {
      scope.domains.add(item.rootDomain.toLowerCase());
    }

    if (item.inputKind === "domain") {
      scope.domains.add(item.normalizedValue.toLowerCase());
    }

    if (item.inputKind === "url") {
      scope.urls.add(item.normalizedValue);
      if (item.hostname) {
        scope.domains.add(item.hostname.toLowerCase());
      }
    }

    if (item.inputKind === "email" && item.email) {
      scope.emails.add(item.email.canonical.toLowerCase());
      scope.domains.add(item.email.domain.toLowerCase());
      for (const username of item.email.derivedUsernames) {
        scope.usernames.add(username.toLowerCase());
      }
    }
  }

  return scope;
}

async function deriveInitialIps(scope: ScopeState): Promise<void> {
  for (const domain of Array.from(scope.domains)) {
    try {
      const ips = await resolve4(domain);
      ips.forEach((ip) => scope.ips.add(ip));
    } catch {
      // ignore
    }

    try {
      const ips6 = await resolve6(domain);
      ips6.forEach((ip) => scope.ips.add(ip));
    } catch {
      // ignore
    }
  }
}

function artifactTypeForRaw(raw: unknown): "raw" | "xml" | "json" | "text" {
  if (typeof raw === "string" && raw.trim().startsWith("<")) {
    return "xml";
  }
  if (typeof raw === "object") {
    return "json";
  }
  return "text";
}

function extractDerived(parsed: Record<string, unknown>, raw: unknown): EnricherOutput["derived"] {
  const parsedText = JSON.stringify(parsed ?? {});
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});

  const extracted = extractIocsFromText(`${parsedText}\n${rawText}`);

  const certFingerprints = Array.from(
    new Set([
      ...readStringArray(parsed.certFingerprints),
      ...readStringArray((parsed as any).certFingerprints),
      ...readStringArray((parsed as any).certs)
    ])
  );

  const usernames = Array.from(
    new Set([
      ...readStringArray((parsed as any).usernames),
      ...readStringArray((parsed as any).profileUrls).flatMap((url) => {
        try {
          const u = new URL(url);
          return u.pathname.split("/").filter(Boolean).slice(-1);
        } catch {
          return [];
        }
      }),
      ...extracted.emails.map((e) => e.split("@")[0])
    ])
  );

  return {
    ips: extracted.ips,
    usernames,
    phones: extracted.phones,
    emails: extracted.emails,
    domains: extracted.domains,
    urls: extracted.urls,
    certFingerprints
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry)).filter(Boolean);
}

async function maybeInsertCase(config: AppConfig, input: InvestigationInput, outputDir: string): Promise<void> {
  if (!isPgConfigured(config)) {
    return;
  }

  const client = new Client({
    ...(config.supabase.postgresUrl
      ? {
          connectionString: config.supabase.postgresUrl,
          ssl: { rejectUnauthorized: false }
        }
      : {
          host: config.pg.host,
          port: config.pg.port,
          user: config.pg.user,
          password: config.pg.password,
          database: config.pg.database,
          ssl: config.pg.ssl ? { rejectUnauthorized: false } : undefined
        })
  });

  try {
    await client.connect();
    await client.query(
      `INSERT INTO intel_cases (case_id, created_at, tlp, inputs, metadata)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (case_id) DO NOTHING`,
      [
        input.caseId,
        input.startedAtUtc,
        input.tlp,
        JSON.stringify(input.normalizedInputs),
        JSON.stringify({
          raw_inputs: input.rawInputs,
          output_dir: outputDir
        })
      ]
    );
  } catch {
    // DB optional at runtime, mandatory for configured deployments
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function executeAdapter(params: {
  adapter: EnricherAdapter;
  context: EnricherContext;
  scope: ScopeState;
  artifactStore: ArtifactStore;
  audit: AuditLogger;
  wave: number;
}): Promise<EnricherOutput> {
  const { adapter, context, scope, artifactStore, audit, wave } = params;

  await audit.log({
    eventType: "tool_run",
    wave,
    toolName: adapter.tool_name,
    status: "started",
    message: `Running ${adapter.tool_name}`,
    details: {
      inputs_required: adapter.inputs_required,
      can_run_from: adapter.can_run_from,
      collection_method: adapter.collectionMethod
    }
  });

  try {
    const runResult = await adapter.run(context);
    const rawArtifact = await artifactStore.putArtifact({
      toolName: adapter.tool_name,
      artifactType: artifactTypeForRaw(runResult.raw),
      payload: runResult.raw,
      collectionMethod: adapter.collectionMethod,
      endpoint: runResult.endpoint,
      toolVersion: runResult.toolVersion,
      metadata: {
        status: runResult.status,
        statusReason: runResult.statusReason,
        wave
      }
    });

    const parsed = await adapter.parse(runResult.raw, context);
    const parsedArtifact = await artifactStore.putArtifact({
      toolName: adapter.tool_name,
      artifactType: "parsed",
      payload: parsed,
      collectionMethod: adapter.collectionMethod,
      endpoint: runResult.endpoint,
      toolVersion: runResult.toolVersion,
      metadata: {
        sourceArtifactId: rawArtifact.artifactId,
        wave
      }
    });

    const derived = extractDerived(parsed, runResult.raw);
    const output: EnricherOutput = {
      toolName: adapter.tool_name,
      status: runResult.status,
      statusReason: runResult.statusReason,
      summary:
        runResult.summary ??
        runResult.statusReason ??
        (runResult.status === "ok" ? "Completed" : "Not configured"),
      parsed,
      raw: runResult.raw,
      artifacts: [rawArtifact, parsedArtifact],
      derived
    };

    scope.findings[adapter.tool_name] = output;
    deriveScopeFromFindings(scope, [output]);

    await audit.log({
      eventType: "tool_run",
      wave,
      toolName: adapter.tool_name,
      status: runResult.status === "error" ? "failed" : runResult.status === "skipped" ? "skipped" : "completed",
      message: `${adapter.tool_name}: ${output.summary}`,
      details: {
        status: runResult.status,
        artifactIds: output.artifacts.map((a) => a.artifactId)
      }
    });

    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    const errorArtifact = await artifactStore.putArtifact({
      toolName: adapter.tool_name,
      artifactType: "error",
      payload: {
        error: message
      },
      collectionMethod: adapter.collectionMethod,
      metadata: {
        wave
      }
    });

    const output: EnricherOutput = {
      toolName: adapter.tool_name,
      status: "error",
      summary: `Execution failed: ${message}`,
      parsed: {},
      artifacts: [errorArtifact],
      derived: {
        ips: [],
        usernames: [],
        phones: [],
        emails: [],
        domains: [],
        urls: [],
        certFingerprints: []
      }
    };

    scope.findings[adapter.tool_name] = output;

    await audit.log({
      eventType: "tool_run",
      wave,
      toolName: adapter.tool_name,
      status: "failed",
      message,
      details: {
        artifactId: errorArtifact.artifactId
      }
    });

    return output;
  }
}

export async function runInvestigation(
  input: InvestigationInput,
  config: AppConfig,
  options: { activeRecon: boolean; reconMode?: "standard" | "aggressive" }
): Promise<InvestigationResult> {
  const outputDir = path.join(config.outputRoot, input.caseId);
  await fs.mkdir(outputDir, { recursive: true });

  const artifactStore = new ArtifactStore(input.caseId, outputDir, config);
  await artifactStore.init();
  await maybeInsertCase(config, input, outputDir);

  const audit = new AuditLogger(input.caseId, outputDir, config);
  await audit.init();

  const scope = initScope(input);
  await deriveInitialIps(scope);

  const context: EnricherContext = {
    caseId: input.caseId,
    nowUtc: new Date().toISOString(),
    activeReconEnabled: options.activeRecon,
    reconMode: options.reconMode ?? "standard",
    config,
    input,
    scope,
    utilities: {
      fetchJson,
      fetchText,
      runCommand
    }
  };

  const enrichments: EnricherOutput[] = [];

  await audit.log({
    eventType: "wave",
    wave: 0,
    status: "completed",
    message: "Wave 0 normalization completed",
    details: {
      tool_count: TOOL_COUNT,
      normalized_inputs: input.normalizedInputs.length,
      initial_ips: Array.from(scope.ips)
    }
  });

  for (const wave of [1, 2, 3, 4, 5]) {
    await audit.log({
      eventType: "wave",
      wave,
      status: "started",
      message: `Wave ${wave} started`,
      details: {}
    });

    const adapters = ENRICHERS_BY_WAVE.filter((entry) => entry.wave === wave).map((entry) => entry.adapter);
    const outputs = await Promise.all(
      adapters.map((adapter) =>
        executeAdapter({
          adapter,
          context,
          scope,
          artifactStore,
          audit,
          wave
        })
      )
    );
    enrichments.push(...outputs);

    await audit.log({
      eventType: "wave",
      wave,
      status: "completed",
      message: `Wave ${wave} completed`,
      details: {
        findings_count: enrichments.length,
        scope_counts: {
          domains: scope.domains.size,
          urls: scope.urls.size,
          emails: scope.emails.size,
          ips: scope.ips.size,
          usernames: scope.usernames.size,
          phones: scope.phones.size,
          certs: scope.certFingerprints.size
        }
      }
    });
  }

  const { graph, keyLinkages } = fuseFindings(input, scope, enrichments);
  const score = computeRiskScore(enrichments);
  const toolReadiness = buildToolReadinessReport(enrichments);

  const reportHtml = generateReportHtml({
    input,
    enrichments,
    toolReadiness,
    graph,
    score,
    keyLinkages,
    evidence: artifactStore.getAll(),
    methodsReference:
      (scope.findings["OSINT Framework"]?.parsed.methodsReference as Array<{ category: string; tools: string[] }>) ?? []
  });

  const { reportHtmlPath, evidenceJsonPath, auditJsonPath } = await exportBundle({
    outputDir,
    reportHtml,
    artifactStore,
    audit,
    keyLinkages,
    score,
    graph,
    input,
    enrichments,
    toolReadiness
  });

  await artifactStore.close();
  await audit.close();

  return {
    caseId: input.caseId,
    input,
    scope,
    enrichments,
    toolReadiness,
    graph,
    score,
    keyLinkages,
    auditLog: audit.getEvents(),
    evidence: artifactStore.getAll(),
    reportHtmlPath,
    evidenceJsonPath,
    auditJsonPath
  };
}
