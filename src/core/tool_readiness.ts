import { getRequiredTools, getToolCoverageSnapshot } from "./tool_manifest.js";
import { EnricherOutput, ToolReadinessReport, ToolReadinessState } from "./types.js";

function classifySkippedReason(reason: string): ToolReadinessState {
  const text = reason.toLowerCase();
  if (text.includes("429") || text.includes("too many requests") || text.includes("rate limit")) {
    return "skipped_rate_limited";
  }
  if (
    text.includes("not installed") ||
    text.includes("binary") ||
    text.includes("cli") ||
    text.includes("missing dependency")
  ) {
    return "skipped_dependency";
  }
  if (
    text.includes("active recon disabled") ||
    text.includes("disabled") ||
    text.includes("policy") ||
    text.includes("toggle")
  ) {
    return "skipped_by_policy";
  }
  if (
    text.includes("no ") ||
    text.includes("not provided") ||
    text.includes("out-of-scope") ||
    text.includes("out of scope")
  ) {
    return "skipped_no_input";
  }
  return "skipped_no_input";
}

function classifyFinding(finding?: EnricherOutput): { readiness: ToolReadinessState; reason: string } {
  if (!finding) {
    return {
      readiness: "missing",
      reason: "Required adapter missing from execution output"
    };
  }

  const reason = finding.statusReason ?? finding.summary ?? "";
  if (finding.status === "ok") {
    return { readiness: "ran_ok", reason: reason || "Executed successfully" };
  }
  if (finding.status === "error") {
    return { readiness: "ran_error", reason: reason || "Execution failed" };
  }
  if (finding.status === "not_configured") {
    return { readiness: "not_configured", reason: reason || "Not configured" };
  }
  if (finding.status === "disabled") {
    return { readiness: "disabled_out_of_scope", reason: reason || "Disabled for scope/policy" };
  }
  return {
    readiness: classifySkippedReason(reason),
    reason: reason || "Skipped"
  };
}

function emptyCounts(): Record<ToolReadinessState, number> {
  return {
    ran_ok: 0,
    ran_error: 0,
    not_configured: 0,
    disabled_out_of_scope: 0,
    skipped_no_input: 0,
    skipped_dependency: 0,
    skipped_rate_limited: 0,
    skipped_by_policy: 0,
    missing: 0
  };
}

export function buildToolReadinessReport(enrichments: EnricherOutput[]): ToolReadinessReport {
  const requiredTools = getRequiredTools();
  const coverage = getToolCoverageSnapshot();
  const byToolName = new Map<string, EnricherOutput>();
  for (const finding of enrichments) {
    byToolName.set(finding.toolName, finding);
  }

  const items = requiredTools.map((tool) => {
    const matchedAlias = tool.aliases.find((alias) => byToolName.has(alias));
    const finding = matchedAlias ? byToolName.get(matchedAlias) : undefined;
    const classified = classifyFinding(finding);
    return {
      id: tool.id,
      expectedName: tool.expectedName,
      adapterName: finding?.toolName,
      runStatus: finding?.status,
      readiness: classified.readiness,
      reason: classified.reason,
      artifactIds: finding?.artifacts.map((artifact) => artifact.artifactId) ?? []
    };
  });

  const requiredNames = new Set(requiredTools.flatMap((tool) => tool.aliases));
  const extraImplemented = enrichments
    .map((finding) => finding.toolName)
    .filter((name) => !requiredNames.has(name))
    .sort((a, b) => a.localeCompare(b));

  const counts = emptyCounts();
  for (const item of items) {
    counts[item.readiness] += 1;
  }

  return {
    requiredCount: coverage.requiredCount,
    implementedCount: coverage.implementedCount,
    missingRequired: coverage.missingRequired,
    extraImplemented,
    coveragePass: coverage.missingRequired.length === 0,
    counts,
    items
  };
}
