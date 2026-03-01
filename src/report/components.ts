import { EvidenceArtifact, EnricherOutput, GraphOutput, InvestigationInput, RiskScore } from "../core/types.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function tag(label: string): string {
  const cls = label.toLowerCase();
  return `<span class="tag tag-${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
}

export function metricBox(label: string, value: string | number): string {
  return `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(
    value
  )}</div></div>`;
}

export function kvRow(key: string, value: unknown): string {
  return `<div class="kv-row"><div class="kv-key">${escapeHtml(key)}</div><div class="kv-value">${escapeHtml(value)}</div></div>`;
}

export function codeBlock(content: string, language = "json"): string {
  return `<div class="code-wrap"><button class="copy-btn" data-copy>${escapeHtml("Copy")}</button><pre><code class="lang-${escapeHtml(
    language
  )}">${escapeHtml(content)}</code></pre></div>`;
}

export function table(headers: string[], rows: Array<Array<string | number>>): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export function timeline(events: Array<{ title: string; subtitle?: string; time?: string }>): string {
  return `<div class="timeline">${events
    .map(
      (event) => `<div class="timeline-item">
        <div class="timeline-dot"></div>
        <div>
          <div class="timeline-title">${escapeHtml(event.title)}</div>
          ${event.subtitle ? `<div class="timeline-subtitle">${escapeHtml(event.subtitle)}</div>` : ""}
          ${event.time ? `<div class="timeline-time">${escapeHtml(event.time)}</div>` : ""}
        </div>
      </div>`
    )
    .join("")}</div>`;
}

export function coverSlide(input: InvestigationInput, score: RiskScore): string {
  return `<section class="slide" data-title="Cover">
    <h1>Highway Phisherman Report</h1>
    <div class="row">${tag(score.severity)} ${tag("ACTIVE")} ${tag("CONFIRMED")} ${tag("INFO")}</div>
    <div class="grid metrics">
      ${metricBox("Case ID", input.caseId)}
      ${metricBox("TLP", input.tlp)}
      ${metricBox("Started (UTC)", input.startedAtUtc)}
      ${metricBox("Risk Score", score.total)}
      ${metricBox("Confidence", `${score.confidencePct}%`)}
    </div>
  </section>`;
}

export function executiveSummarySlide(score: RiskScore, keyLinkages: Array<{ text: string; evidenceIds: string[] }>): string {
  const linkageRows = keyLinkages.slice(0, 8).map((item) =>
    `<li>${escapeHtml(item.text)} <span class="muted">[${escapeHtml(item.evidenceIds.join(", "))}]</span></li>`
  );

  return `<section class="slide" data-title="Executive Summary">
    <h2>Executive Summary</h2>
    <div class="grid metrics">
      ${metricBox("Severity", score.severity)}
      ${metricBox("Score", score.total)}
      ${metricBox("Confidence", `${score.confidencePct}%`)}
      ${metricBox("Signals", score.breakdown.length)}
    </div>
    <h3>Key Linkages</h3>
    <ul>${linkageRows.join("") || "<li>No strong cross-tool linkages.</li>"}</ul>
  </section>`;
}

export function normalizationSlide(input: InvestigationInput): string {
  const rows = input.normalizedInputs.map((item) =>
    `<tr><td>${escapeHtml(item.inputKind)}</td><td>${escapeHtml(item.original)}</td><td>${escapeHtml(
      item.normalizedValue
    )}</td><td>${escapeHtml(item.rootDomain ?? "")}</td><td>${escapeHtml(JSON.stringify(item.flags))}</td></tr>`
  );

  return `<section class="slide" data-title="Inputs & Normalization">
    <h2>Inputs & Normalization</h2>
    <table>
      <thead><tr><th>Type</th><th>Original</th><th>Normalized</th><th>Root Domain</th><th>Flags</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </section>`;
}

export function scoreSlide(score: RiskScore): string {
  return `<section class="slide" data-title="Threat Assessment">
    <h2>Threat Assessment</h2>
    <div class="grid metrics">
      ${metricBox("Total Score", score.total)}
      ${metricBox("Severity", score.severity)}
      ${metricBox("Confidence", `${score.confidencePct}%`)}
    </div>
    ${table(
      ["Signal", "Description", "Points", "Evidence IDs"],
      score.breakdown.map((item) => [item.signalId, item.description, item.points, item.evidenceIds.join(", ") || "-"])
    )}
  </section>`;
}

export function graphSlide(graph: GraphOutput): string {
  const nodeRows = graph.nodes.slice(0, 20).map((node) => [node.type, node.label, node.tags.join(", "), node.evidenceIds.join(", ")]);
  return `<section class="slide" data-title="Correlation Graph">
    <h2>Correlation Graph</h2>
    <div class="grid metrics">
      ${metricBox("Nodes", graph.metrics.nodeCount)}
      ${metricBox("Edges", graph.metrics.edgeCount)}
      ${metricBox("Components", graph.metrics.connectedComponents)}
    </div>
    ${table(["Type", "Label", "Tags", "Evidence"], nodeRows)}
    ${codeBlock(JSON.stringify(graph, null, 2), "json")}
  </section>`;
}

export function toolSlide(finding: EnricherOutput): string {
  const statusTag = finding.status === "error" ? "CRITICAL" : finding.status === "ok" ? "CONFIRMED" : "INFO";
  const parsedPreview = JSON.stringify(finding.parsed, null, 2).slice(0, 6000);
  return `<section class="slide" data-title="${escapeHtml(finding.toolName)}">
    <h2>${escapeHtml(finding.toolName)}</h2>
    <div class="row">${tag(statusTag)} ${tag(finding.status.toUpperCase())}</div>
    <div class="kv">
      ${kvRow("Status", finding.status)}
      ${kvRow("Reason", finding.statusReason ?? "-")}
      ${kvRow("Summary", finding.summary)}
      ${kvRow("Artifacts", finding.artifacts.map((a) => a.artifactId).join(", "))}
    </div>
    ${codeBlock(parsedPreview, "json")}
  </section>`;
}

export function evidenceSlide(artifact: EvidenceArtifact): string {
  return `<section class="slide" data-title="Evidence ${escapeHtml(artifact.artifactId)}">
    <h2>Evidence Artifact</h2>
    <div class="kv">
      ${kvRow("Artifact ID", artifact.artifactId)}
      ${kvRow("Tool", artifact.toolName)}
      ${kvRow("Type", artifact.artifactType)}
      ${kvRow("Collection Method", artifact.collectionMethod)}
      ${kvRow("SHA-256", artifact.sha256)}
      ${kvRow("Timestamp (UTC)", artifact.createdAtUtc)}
      ${kvRow("Path", artifact.filePath)}
    </div>
  </section>`;
}
