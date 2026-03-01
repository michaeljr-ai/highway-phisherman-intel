import { EnricherOutput, RiskScore, ScoreBreakdownItem } from "./types.js";

function severityFromScore(score: number): RiskScore["severity"] {
  if (score >= 61) {
    return "CRITICAL";
  }
  if (score >= 41) {
    return "HIGH";
  }
  if (score >= 21) {
    return "MED";
  }
  return "LOW";
}

function byTool(findings: EnricherOutput[], toolName: string): EnricherOutput | undefined {
  return findings.find((f) => f.toolName.toLowerCase() === toolName.toLowerCase());
}

function evidenceIds(finding: EnricherOutput | undefined): string[] {
  if (!finding) {
    return [];
  }
  return finding.artifacts.map((a) => a.artifactId);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function addBreakdown(
  list: ScoreBreakdownItem[],
  signalId: string,
  description: string,
  points: number,
  evidence: string[]
): void {
  if (points <= 0) {
    return;
  }
  list.push({ signalId, description, points, evidenceIds: evidence });
}

export function computeRiskScore(findings: EnricherOutput[]): RiskScore {
  const breakdown: ScoreBreakdownItem[] = [];

  const rdap = byTool(findings, "RDAP");
  const domainAgeDays = asNumber(rdap?.parsed.domainAgeDays, 3650);
  if (domainAgeDays < 180) {
    addBreakdown(breakdown, "domain_new", "Domain is newly registered (<180 days)", 20, evidenceIds(rdap));
  }

  const vt = byTool(findings, "VirusTotal API");
  const vtDetections = asNumber(vt?.parsed.maliciousDetections, 0);
  if (vtDetections >= 5) {
    addBreakdown(breakdown, "vt_detections", "VirusTotal detections exceed threshold", 25, evidenceIds(vt));
  }

  const blacklist = byTool(findings, "Blacklist/Reputation Check APIs");
  const blacklistHits = asNumber(blacklist?.parsed.hitCount, 0);
  if (blacklistHits >= 1) {
    addBreakdown(breakdown, "blacklist_hit", "Domain or IP appears on blacklist sources", 20, evidenceIds(blacklist));
  }

  const shodan = byTool(findings, "Shodan API");
  const sharedHtmlHash = Boolean(shodan?.parsed.sharedHtmlHashWithFlagged);
  if (sharedHtmlHash) {
    addBreakdown(
      breakdown,
      "html_hash_reuse",
      "HTML fingerprint overlap with flagged infrastructure",
      20,
      evidenceIds(shodan)
    );
  }

  const crtsh = byTool(findings, "crt.sh");
  const certReuse = Boolean(crtsh?.parsed.unrelatedDomainCertReuse);
  if (certReuse) {
    addBreakdown(breakdown, "cert_reuse", "Certificate reused across unrelated domains", 15, evidenceIds(crtsh));
  }

  const mx = byTool(findings, "DNS MX Record Lookup");
  const spfDmarc = byTool(findings, "DNS TXT/SPF/DMARC Analysis");
  const noMx = Boolean(mx?.parsed.noMx);
  const weakMailAuth = Boolean(spfDmarc?.parsed.weakPolicy);
  if (noMx || weakMailAuth) {
    addBreakdown(
      breakdown,
      "mail_auth_weak",
      "Mail infrastructure appears weak (no MX or weak SPF/DMARC)",
      10,
      [...evidenceIds(mx), ...evidenceIds(spfDmarc)]
    );
  }

  const dns = byTool(findings, "DNS Records");
  const soaLeak = Boolean(dns?.parsed.soaRnameLeak);
  if (soaLeak) {
    addBreakdown(breakdown, "soa_leak", "SOA rname/admin email leak observed", 15, evidenceIds(dns));
  }

  const abuse = byTool(findings, "AbuseIPDB API");
  const ipqs = byTool(findings, "IPQualityScore (IPQS)");
  const scamalytics = byTool(findings, "Scamalytics API");
  const abuseHigh = asNumber(abuse?.parsed.maxAbuseConfidence, 0) >= 80;
  const ipqsFraud = asNumber(ipqs?.parsed.maxFraudScore, 0) >= 75;
  const scamFraud = asNumber(scamalytics?.parsed.maxFraudScore, 0) >= 75;
  const agreementCount = [abuseHigh, ipqsFraud, scamFraud].filter(Boolean).length;
  if (agreementCount >= 2) {
    addBreakdown(
      breakdown,
      "ip_abuse_agreement",
      "Multiple IP risk sources agree on high abuse/proxy risk",
      20,
      [...evidenceIds(abuse), ...evidenceIds(ipqs), ...evidenceIds(scamalytics)]
    );
  } else if (agreementCount === 1) {
    addBreakdown(
      breakdown,
      "ip_abuse_partial",
      "Single-source IP abuse/proxy signal",
      10,
      [...evidenceIds(abuse), ...evidenceIds(ipqs), ...evidenceIds(scamalytics)]
    );
  }

  const urlscan = byTool(findings, "URLScan.io API");
  if (Boolean(urlscan?.parsed.credentialHarvestPattern)) {
    addBreakdown(
      breakdown,
      "credential_harvest",
      "URL behavior suggests credential-harvest UI patterns",
      25,
      evidenceIds(urlscan)
    );
  }

  const holehe = byTool(findings, "Holehe");
  if (Boolean(holehe?.parsed.highRiskPlatformPresence)) {
    addBreakdown(
      breakdown,
      "email_high_risk_platform",
      "Email appears on high-risk service categories",
      20,
      evidenceIds(holehe)
    );
  }

  const hunter = byTool(findings, "Hunter.io API");
  if (Boolean(hunter?.parsed.catchAll)) {
    addBreakdown(
      breakdown,
      "catch_all_domain",
      "Catch-all email domain allows arbitrary mailbox creation",
      15,
      evidenceIds(hunter)
    );
  }

  const stopForumSpam = byTool(findings, "StopForumSpam API");
  if (Boolean(stopForumSpam?.parsed.hit)) {
    addBreakdown(breakdown, "sfs_hit", "StopForumSpam positive hit", 10, evidenceIds(stopForumSpam));
  }

  const usernameTools = [
    byTool(findings, "Sherlock"),
    byTool(findings, "Maigret"),
    byTool(findings, "Blackbird"),
    byTool(findings, "Socialscan")
  ].filter(Boolean) as EnricherOutput[];
  const usernamesFound = usernameTools.reduce((sum, f) => sum + asNumber(f.parsed.confirmedCount, 0), 0);
  if (usernamesFound >= 3) {
    addBreakdown(
      breakdown,
      "username_surface",
      "Multi-tool username presence observed",
      10,
      usernameTools.flatMap((f) => evidenceIds(f))
    );
  }

  const total = breakdown.reduce((sum, item) => sum + item.points, 0);

  const configuredCount = findings.filter((f) => f.status !== "not_configured" && f.status !== "disabled").length;
  const okCount = findings.filter((f) => f.status === "ok").length;
  const agreementWeight = breakdown.length > 0 ? Math.min(100, Math.round((okCount / Math.max(1, configuredCount)) * 100)) : 25;
  const completenessWeight = Math.min(100, Math.round((configuredCount / Math.max(1, findings.length)) * 100));
  const confidencePct = Math.round((agreementWeight * 0.6 + completenessWeight * 0.4) * 100) / 100;

  return {
    total,
    severity: severityFromScore(total),
    confidencePct,
    breakdown
  };
}
