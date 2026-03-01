import { promises as fs } from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../core/artifacts.js";
import { AuditLogger } from "../core/audit.js";
import { EnricherOutput, GraphOutput, InvestigationInput, RiskScore, ToolReadinessReport } from "../core/types.js";

export async function exportBundle(params: {
  outputDir: string;
  reportHtml: string;
  artifactStore: ArtifactStore;
  audit: AuditLogger;
  keyLinkages: Array<{ text: string; evidenceIds: string[] }>;
  score: RiskScore;
  graph: GraphOutput;
  input: InvestigationInput;
  enrichments: EnricherOutput[];
  toolReadiness: ToolReadinessReport;
}): Promise<{ reportHtmlPath: string; evidenceJsonPath: string; auditJsonPath: string }> {
  const { outputDir, reportHtml, artifactStore, audit, keyLinkages, score, graph, input, enrichments, toolReadiness } = params;

  await fs.mkdir(outputDir, { recursive: true });

  const reportHtmlPath = path.join(outputDir, "report.html");
  await fs.writeFile(reportHtmlPath, reportHtml, "utf8");

  const evidenceJsonPath = await artifactStore.exportIndex({
    case: input,
    score,
    graph_summary: {
      nodes: graph.metrics.nodeCount,
      edges: graph.metrics.edgeCount,
      components: graph.metrics.connectedComponents
    },
    key_linkages: keyLinkages,
    tool_readiness: toolReadiness,
    tools: enrichments.map((item) => ({
      tool: item.toolName,
      status: item.status,
      status_reason: item.statusReason ?? "",
      summary: item.summary,
      artifact_ids: item.artifacts.map((artifact) => artifact.artifactId)
    }))
  });

  const auditJsonPath = await audit.exportJson();

  return {
    reportHtmlPath,
    evidenceJsonPath,
    auditJsonPath
  };
}
