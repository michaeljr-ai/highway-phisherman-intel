import { readFileSync } from "node:fs";
import path from "node:path";
import {
  codeBlock,
  coverSlide,
  escapeHtml,
  executiveSummarySlide,
  graphSlide,
  kvRow,
  metricBox,
  normalizationSlide,
  scoreSlide,
  table,
  tag,
  timeline,
  toolSlide
} from "./components.js";
import {
  EnricherOutput,
  EvidenceArtifact,
  GraphOutput,
  InvestigationInput,
  MethodsReference,
  RiskScore,
  ToolReadinessReport
} from "../core/types.js";

interface GeneratorInput {
  input: InvestigationInput;
  enrichments: EnricherOutput[];
  toolReadiness: ToolReadinessReport;
  graph: GraphOutput;
  score: RiskScore;
  keyLinkages: Array<{ text: string; evidenceIds: string[] }>;
  evidence: EvidenceArtifact[];
  methodsReference: MethodsReference[];
}

function getFinding(findings: EnricherOutput[], toolName: string): EnricherOutput | undefined {
  return findings.find((f) => f.toolName === toolName);
}

function summarySectionSlide(title: string, rows: Array<{ key: string; value: unknown }>, tags: string[] = []): string {
  return `<section class="slide" data-title="${escapeHtml(title)}">
    <h2>${escapeHtml(title)}</h2>
    <div class="row">${tags.map((t) => tag(t)).join(" ")}</div>
    <div class="kv">${rows.map((row) => kvRow(row.key, row.value)).join("")}</div>
  </section>`;
}

function readinessLabel(state: string): string {
  const labels: Record<string, string> = {
    ran_ok: "RAN OK",
    ran_error: "RAN ERROR",
    not_configured: "NOT CONFIGURED",
    disabled_out_of_scope: "DISABLED (SCOPE)",
    skipped_no_input: "SKIPPED (NO INPUT)",
    skipped_dependency: "SKIPPED (DEPENDENCY)",
    skipped_rate_limited: "SKIPPED (RATE LIMIT)",
    skipped_by_policy: "SKIPPED (POLICY)",
    missing: "MISSING"
  };
  return labels[state] ?? state.toUpperCase();
}

function toolHealthSlide(toolReadiness: ToolReadinessReport): string {
  const rows = toolReadiness.items.map((item) => [
    `${item.id}. ${item.expectedName}`,
    readinessLabel(item.readiness),
    item.runStatus ?? "-",
    item.reason,
    item.artifactIds.slice(0, 4).join(", ") || "-"
  ]);

  return `<section class="slide" data-title="Tool Health & Coverage">
    <h2>Tool Health & Coverage</h2>
    <div class="grid metrics">
      ${metricBox("Required Tools", toolReadiness.requiredCount)}
      ${metricBox("Implemented", toolReadiness.implementedCount)}
      ${metricBox("Coverage", toolReadiness.coveragePass ? "PASS" : "FAIL")}
      ${metricBox("Ran OK", toolReadiness.counts.ran_ok)}
      ${metricBox("Ran Error", toolReadiness.counts.ran_error)}
      ${metricBox("Not Configured", toolReadiness.counts.not_configured)}
      ${metricBox("Disabled/Skipped", toolReadiness.counts.disabled_out_of_scope + toolReadiness.counts.skipped_no_input + toolReadiness.counts.skipped_dependency + toolReadiness.counts.skipped_rate_limited + toolReadiness.counts.skipped_by_policy)}
    </div>
    ${table(["Tool", "Readiness", "Run Status", "Reason", "Evidence IDs"], rows)}
    ${
      toolReadiness.extraImplemented.length > 0
        ? `<h3>Additional Adapters</h3>${codeBlock(JSON.stringify(toolReadiness.extraImplemented, null, 2), "json")}`
        : ""
    }
  </section>`;
}

function laymanSignal(signalId: string): string {
  const map: Record<string, string> = {
    domain_new: "The domain is very new, which is common in throwaway scam/phishing setups.",
    vt_detections: "Multiple security engines are already flagging this target.",
    blacklist_hit: "At least one reputation source already lists this target as risky.",
    html_hash_reuse: "The web page looks technically identical to known bad infrastructure.",
    cert_reuse: "The same certificate appears across unrelated domains, a known abuse pattern.",
    mail_auth_weak: "Email protections are weak or missing, which helps spoofing/phishing.",
    soa_leak: "DNS admin metadata leaks operational details that can aid attackers.",
    ip_abuse_agreement: "Several independent IP-risk sources agree this infrastructure is suspicious.",
    ip_abuse_partial: "One IP-risk source raised concern; signal is weaker but still notable.",
    credential_harvest: "Observed behavior resembles credential-harvesting login workflows.",
    email_high_risk_platform: "Email appears on services frequently seen in abuse workflows.",
    catch_all_domain: "Catch-all email can enable fast creation of disposable inboxes.",
    sfs_hit: "Spam-abuse records already exist for this identity or infrastructure.",
    username_surface: "The same username pattern appears broadly across multiple services."
  };
  return map[signalId] ?? "This signal indicates suspicious operational overlap.";
}

function severityLaymanText(severity: RiskScore["severity"]): string {
  if (severity === "CRITICAL") {
    return "High immediate risk. Treat this as likely hostile until disproven.";
  }
  if (severity === "HIGH") {
    return "Strong risk indicators. Escalate for containment and blocking decisions.";
  }
  if (severity === "MED") {
    return "Mixed but meaningful risk indicators. Monitor closely and apply controls.";
  }
  return "Low observed risk right now, but continue monitoring for changes.";
}

function plainEnglishIntelSlide(score: RiskScore, findings: EnricherOutput[]): string {
  const topSignals = score.breakdown.slice(0, 8);
  const vt = getFinding(findings, "VirusTotal API");
  const actorHints = Array.isArray(vt?.parsed.actorHints)
    ? (vt?.parsed.actorHints as unknown[]).map((v) => String(v)).filter(Boolean).slice(0, 6)
    : [];

  const attributionText =
    actorHints.length > 0
      ? `Source-reported labels seen: ${actorHints.join(", ")}. This is third-party labeling, not confirmed attribution.`
      : "No source-backed country/group attribution was found in current evidence. Avoid nation-state claims without direct corroboration.";

  return `<section class="slide" data-title="Plain-English Intel">
    <h2>Plain-English Intel</h2>
    <div class="grid metrics">
      ${metricBox("Overall Risk", score.severity)}
      ${metricBox("Score", score.total)}
      ${metricBox("Confidence", `${score.confidencePct}%`)}
    </div>
    <p>${escapeHtml(severityLaymanText(score.severity))}</p>
    <h3>What This Means</h3>
    <ul>
      ${topSignals
        .map(
          (item) =>
            `<li>${escapeHtml(laymanSignal(item.signalId))} <span class="muted">[evidence: ${escapeHtml(
              item.evidenceIds.join(", ") || "-"
            )}]</span></li>`
        )
        .join("")}
    </ul>
    <h3>Attribution Note</h3>
    <p>${escapeHtml(attributionText)}</p>
  </section>`;
}

function domainLifecycleSlide(findings: EnricherOutput[]): string {
  const rdap = getFinding(findings, "RDAP");
  return `<section class="slide" data-title="Domain Lifecycle">
    <h2>Domain Lifecycle (RDAP/WHOIS Signals)</h2>
    <div class="grid metrics">
      ${metricBox("Status", rdap?.status ?? "n/a")}
      ${metricBox("Domain Age (days)", (rdap?.parsed.domainAgeDays as number | undefined) ?? "n/a")}
      ${metricBox("Registrar Signals", Array.isArray(rdap?.parsed.registrar) ? rdap?.parsed.registrar.length : 0)}
    </div>
    ${codeBlock(JSON.stringify(rdap?.parsed ?? { note: "Not configured" }, null, 2))}
  </section>`;
}

function dnsMailSlide(findings: EnricherOutput[]): string {
  const dns = getFinding(findings, "DNS Records");
  const mx = getFinding(findings, "DNS MX Record Lookup");
  const dmarc = getFinding(findings, "DNS TXT/SPF/DMARC Analysis");

  return `<section class="slide" data-title="DNS & Mail Infrastructure">
    <h2>DNS + Mail Infrastructure</h2>
    <div class="grid metrics">
      ${metricBox("A Records", Array.isArray(dns?.parsed.a) ? dns?.parsed.a.length : 0)}
      ${metricBox("MX Records", Array.isArray(mx?.parsed.records) ? mx?.parsed.records.length : 0)}
      ${metricBox("DMARC Policy", (dmarc?.parsed.dmarcPolicy as string | undefined) ?? "none")}
      ${metricBox("SOA Leak", Boolean(dns?.parsed.soaRnameLeak) ? "yes" : "no")}
    </div>
    ${table(
      ["Item", "Value"],
      [
        ["MX Providers", Array.isArray(mx?.parsed.providers) ? mx?.parsed.providers.join(", ") : "n/a"],
        ["SPF", (dmarc?.parsed.spf as string | undefined) ?? "n/a"],
        ["DMARC", (dmarc?.parsed.dmarc as string | undefined) ?? "n/a"],
        ["Leaked Hostnames", Array.isArray(dmarc?.parsed.leakedHostnames) ? dmarc?.parsed.leakedHostnames.join(", ") : "-"]
      ]
    )}
  </section>`;
}

function certSlide(findings: EnricherOutput[]): string {
  const crtsh = getFinding(findings, "crt.sh");
  const censys = getFinding(findings, "Censys");
  const shodan = getFinding(findings, "Shodan API");

  return `<section class="slide" data-title="Certificates">
    <h2>Certificates (crt.sh + Censys + Shodan)</h2>
    <div class="grid metrics">
      ${metricBox("CT Records", (crtsh?.parsed.recordCount as number | undefined) ?? 0)}
      ${metricBox("Wildcard SANs", (crtsh?.parsed.wildcardCount as number | undefined) ?? 0)}
      ${metricBox("Censys Certs", (censys?.parsed.certCount as number | undefined) ?? 0)}
      ${metricBox("Shodan Certs", Array.isArray(shodan?.parsed.certFingerprints) ? shodan?.parsed.certFingerprints.length : 0)}
    </div>
    ${codeBlock(
      JSON.stringify(
        {
          crtsh: crtsh?.parsed,
          censys: censys?.parsed,
          shodan: shodan?.parsed
        },
        null,
        2
      )
    )}
  </section>`;
}

function passiveExposureSlide(findings: EnricherOutput[]): string {
  const shodan = getFinding(findings, "Shodan API");
  const censys = getFinding(findings, "Censys");
  const asn = getFinding(findings, "BGP/ASN Lookup");
  const ptr = getFinding(findings, "Reverse DNS / PTR Records");
  const tor = getFinding(findings, "Tor Check (Tor Project API)");
  const abuse = getFinding(findings, "AbuseIPDB API");

  return `<section class="slide" data-title="Passive Exposure">
    <h2>Passive Exposure</h2>
    <div class="grid metrics">
      ${metricBox("Open Ports", Array.isArray(shodan?.parsed.ports) ? shodan?.parsed.ports.length : 0)}
      ${metricBox("Censys Services", (censys?.parsed.serviceCount as number | undefined) ?? 0)}
      ${metricBox("ASN Count", Array.isArray(asn?.parsed.asns) ? asn?.parsed.asns.length : 0)}
      ${metricBox("PTR Hits", (ptr?.parsed.totalWithPtr as number | undefined) ?? 0)}
      ${metricBox("Tor Exits", (tor?.parsed.exitCount as number | undefined) ?? 0)}
      ${metricBox("Max Abuse", (abuse?.parsed.maxAbuseConfidence as number | undefined) ?? 0)}
    </div>
  </section>`;
}

function urlBehaviorSlide(findings: EnricherOutput[]): string {
  const urlscan = getFinding(findings, "URLScan.io API");
  const live = getFinding(findings, "Live Website Fetching (curl/wget safe mode)");

  return `<section class="slide" data-title="URL Behavior">
    <h2>URL Behavior</h2>
    ${timeline(
      [
        { title: "Observed URL", subtitle: String(urlscan?.parsed.finalUrl ?? live?.parsed.finalUrl ?? "n/a") },
        {
          title: "Redirect Chain",
          subtitle: Array.isArray(urlscan?.parsed.redirectChain)
            ? (urlscan?.parsed.redirectChain as string[]).slice(0, 4).join(" -> ")
            : "n/a"
        },
        { title: "HTTP Status", subtitle: String(live?.parsed.status ?? "n/a") },
        { title: "Page Title", subtitle: String(live?.parsed.title ?? "n/a") }
      ].filter((item) => item.subtitle && item.subtitle !== "")
    )}
    ${codeBlock(JSON.stringify({ urlscan: urlscan?.parsed, live: live?.parsed }, null, 2))}
  </section>`;
}

function emailIntelSlide(findings: EnricherOutput[]): string {
  const hunter = getFinding(findings, "Hunter.io API");
  const holehe = getFinding(findings, "Holehe");
  const gravatar = getFinding(findings, "Gravatar API");

  return `<section class="slide" data-title="Email Intelligence">
    <h2>Email Intelligence</h2>
    <div class="grid metrics">
      ${metricBox("Hunter Catch-all", Boolean(hunter?.parsed.catchAll) ? "yes" : "no")}
      ${metricBox("Holehe Services", (holehe?.parsed.confirmedCount as number | undefined) ?? 0)}
      ${metricBox("High-Risk Presence", Boolean(holehe?.parsed.highRiskPlatformPresence) ? "yes" : "no")}
      ${metricBox("Gravatar Profile", gravatar?.status === "ok" ? "found" : "none")}
    </div>
  </section>`;
}

function usernameSlide(findings: EnricherOutput[]): string {
  const sherlock = getFinding(findings, "Sherlock");
  const maigret = getFinding(findings, "Maigret");
  const blackbird = getFinding(findings, "Blackbird");
  const socialscan = getFinding(findings, "Socialscan");
  const github = getFinding(findings, "GitHub API");

  return `<section class="slide" data-title="Username Footprint">
    <h2>Username Footprint</h2>
    ${table(
      ["Tool", "Confirmed Count", "Status"],
      [
        ["Sherlock", String(sherlock?.parsed.confirmedCount ?? 0), sherlock?.status ?? "n/a"],
        ["Maigret", String(maigret?.parsed.confirmedCount ?? 0), maigret?.status ?? "n/a"],
        ["Blackbird", String(blackbird?.parsed.confirmedCount ?? 0), blackbird?.status ?? "n/a"],
        ["Socialscan", String(socialscan?.parsed.confirmedCount ?? 0), socialscan?.status ?? "n/a"],
        ["GitHub", String(github?.parsed.confirmedCount ?? 0), github?.status ?? "n/a"]
      ]
    )}
  </section>`;
}

function reputationSlide(findings: EnricherOutput[]): string {
  const vt = getFinding(findings, "VirusTotal API");
  const blacklist = getFinding(findings, "Blacklist/Reputation Check APIs");
  const abuse = getFinding(findings, "AbuseIPDB API");
  const ipqs = getFinding(findings, "IPQualityScore (IPQS)");
  const scamalytics = getFinding(findings, "Scamalytics API");

  return `<section class="slide" data-title="Reputation & Abuse">
    <h2>Reputation & Abuse</h2>
    <div class="grid metrics">
      ${metricBox("VT Detections", (vt?.parsed.maliciousDetections as number | undefined) ?? 0)}
      ${metricBox("Blacklist Hits", (blacklist?.parsed.hitCount as number | undefined) ?? 0)}
      ${metricBox("AbuseIPDB Max", (abuse?.parsed.maxAbuseConfidence as number | undefined) ?? 0)}
      ${metricBox("IPQS Max", (ipqs?.parsed.maxFraudScore as number | undefined) ?? 0)}
      ${metricBox("Scamalytics Max", (scamalytics?.parsed.maxFraudScore as number | undefined) ?? 0)}
    </div>
  </section>`;
}

function activeReconSlide(findings: EnricherOutput[]): string {
  const activeTools = ["wafw00f", "Nmap (authorized; active toggle)", "Nuclei (active toggle)", "EyeWitness (active toggle)", "SpiderFoot (active toggle)"];
  const rows = activeTools.map((name) => {
    const finding = getFinding(findings, name);
    return [name, finding?.status ?? "n/a", finding?.summary ?? "n/a"];
  });

  return `<section class="slide" data-title="Optional Active Recon">
    <h2>Optional Active Recon</h2>
    ${table(["Tool", "Status", "Summary"], rows)}
  </section>`;
}

function iocTableSlide(input: InvestigationInput, findings: EnricherOutput[], graph: GraphOutput): string {
  const domains = Array.from(new Set(graph.nodes.filter((n) => n.type === "Domain").map((n) => n.label)));
  const urls = Array.from(new Set(graph.nodes.filter((n) => n.type === "URL").map((n) => n.label)));
  const ips = Array.from(new Set(graph.nodes.filter((n) => n.type === "IP").map((n) => n.label)));
  const emails = Array.from(new Set(graph.nodes.filter((n) => n.type === "Email").map((n) => n.label)));
  const usernames = Array.from(new Set(graph.nodes.filter((n) => n.type === "Username").map((n) => n.label)));
  const certs = Array.from(new Set(graph.nodes.filter((n) => n.type === "Cert").map((n) => n.label)));

  return `<section class="slide" data-title="IOCs Table">
    <h2>IOCs</h2>
    <div class="grid metrics">
      ${metricBox("Domains", domains.length)}
      ${metricBox("URLs", urls.length)}
      ${metricBox("IPs", ips.length)}
      ${metricBox("Emails", emails.length)}
      ${metricBox("Usernames", usernames.length)}
      ${metricBox("Certs", certs.length)}
    </div>
    ${codeBlock(
      JSON.stringify(
        {
          caseId: input.caseId,
          domains,
          urls,
          ips,
          emails,
          usernames,
          certs,
          evidenceByTool: findings.map((f) => ({ tool: f.toolName, artifacts: f.artifacts.map((a) => a.artifactId) }))
        },
        null,
        2
      )
    )}
  </section>`;
}

function recommendationsSlide(score: RiskScore): string {
  const recommendations = [
    "Enforce SPF + DMARC (p=reject) and monitor aggregate reports.",
    "Block or challenge traffic from high-risk IPs and ASN clusters indicated by multiple risk sources.",
    "Enable certificate transparency monitoring and alert on unexpected SAN/fingerprint reuse.",
    "Add URL detonation and redirect-chain anomaly checks to inbound phishing controls.",
    "Harden login surfaces with MFA, anti-phishing branding controls, and takedown process readiness."
  ];

  return `<section class="slide" data-title="Defensive Recommendations">
    <h2>Defensive Recommendations</h2>
    <div class="row">${tag(score.severity)} ${tag("ACTIVE")}</div>
    <ol>${recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
  </section>`;
}

function evidenceAppendixSlide(evidence: EvidenceArtifact[]): string {
  return `<section class="slide" data-title="Evidence Appendix">
    <h2>Evidence Appendix</h2>
    ${table(
      ["Artifact ID", "Tool", "Type", "SHA-256", "Timestamp UTC"],
      evidence.slice(0, 120).map((artifact) => [artifact.artifactId, artifact.toolName, artifact.artifactType, artifact.sha256, artifact.createdAtUtc])
    )}
  </section>`;
}

function methodsSlide(methodsReference: MethodsReference[]): string {
  return `<section class="slide" data-title="Methods Reference">
    <h2>Methods Reference</h2>
    ${table(
      ["Category", "Tools Used"],
      methodsReference.map((item) => [item.category, item.tools.join(", ")])
    )}
  </section>`;
}

function auditTimelineSlide(input: InvestigationInput, findings: EnricherOutput[]): string {
  const events = findings.slice(0, 40).map((f) => ({
    title: f.toolName,
    subtitle: `${f.status}: ${f.summary}`,
    time: f.artifacts[0]?.createdAtUtc
  }));

  return `<section class="slide" data-title="Collection Timeline">
    <h2>Collection Timeline</h2>
    ${timeline([
      { title: "Wave 0", subtitle: "Input normalization", time: input.startedAtUtc },
      ...events
    ])}
  </section>`;
}

export function generateReportHtml(input: GeneratorInput): string {
  const templatePath = path.resolve("src/report/template.html");
  const template = readFileSync(templatePath, "utf8");

  const slides: string[] = [];

  slides.push(coverSlide(input.input, input.score));
  slides.push(executiveSummarySlide(input.score, input.keyLinkages));
  slides.push(toolHealthSlide(input.toolReadiness));
  slides.push(plainEnglishIntelSlide(input.score, input.enrichments));
  slides.push(normalizationSlide(input.input));
  slides.push(scoreSlide(input.score));
  slides.push(domainLifecycleSlide(input.enrichments));
  slides.push(dnsMailSlide(input.enrichments));
  slides.push(certSlide(input.enrichments));
  slides.push(passiveExposureSlide(input.enrichments));
  slides.push(urlBehaviorSlide(input.enrichments));
  slides.push(emailIntelSlide(input.enrichments));
  slides.push(usernameSlide(input.enrichments));
  slides.push(reputationSlide(input.enrichments));
  slides.push(activeReconSlide(input.enrichments));
  slides.push(graphSlide(input.graph));
  slides.push(iocTableSlide(input.input, input.enrichments, input.graph));
  slides.push(recommendationsSlide(input.score));
  slides.push(methodsSlide(input.methodsReference));
  slides.push(auditTimelineSlide(input.input, input.enrichments));
  slides.push(evidenceAppendixSlide(input.evidence));

  for (const finding of input.enrichments) {
    slides.push(toolSlide(finding));
  }

  // Keep report in 60-100 slide range while ensuring a chain-of-custody appendix depth.
  const evidenceSlides = input.evidence.slice(0, Math.max(0, 95 - slides.length));
  for (const artifact of evidenceSlides) {
    slides.push(`<section class="slide" data-title="Evidence ${escapeHtml(artifact.artifactId)}">
      <h2>Evidence Artifact ${escapeHtml(artifact.artifactId)}</h2>
      <div class="kv">
        ${kvRow("Tool", artifact.toolName)}
        ${kvRow("Hash", artifact.sha256)}
        ${kvRow("Method", artifact.collectionMethod)}
        ${kvRow("Path", artifact.filePath)}
      </div>
    </section>`);
  }

  const minSlides = 60;
  while (slides.length < minSlides) {
    slides.push(
      summarySectionSlide("Supplemental Evidence", [
        { key: "Notice", value: "Reserved for additional artifact detail." },
        { key: "Integrity", value: "Every claim in this report ties to evidence IDs and SHA-256 hashes." }
      ])
    );
  }

  const navButtons = slides
    .map((slide, idx) => {
      const titleMatch = slide.match(/data-title="([^"]+)"/);
      const title = titleMatch ? titleMatch[1] : `Slide ${idx + 1}`;
      return `<button data-index="${idx}">${idx + 1}. ${escapeHtml(title)}</button>`;
    })
    .join("");

  return template
    .replace(/__TITLE__/g, `Intelligence Briefing - ${input.input.caseId}`)
    .replace("__NAV__", navButtons)
    .replace("__SLIDES__", slides.join("\n"));
}
