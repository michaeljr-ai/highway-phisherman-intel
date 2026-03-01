import { describe, expect, it } from "vitest";
import { computeRiskScore } from "../src/core/scoring.js";
import { EnricherOutput } from "../src/core/types.js";

function finding(toolName: string, parsed: Record<string, unknown>): EnricherOutput {
  return {
    toolName,
    status: "ok",
    summary: "ok",
    parsed,
    artifacts: [
      {
        artifactId: `${toolName}-a1`,
        caseId: "CASE-1",
        toolName,
        artifactType: "parsed",
        collectionMethod: "passive",
        createdAtUtc: new Date().toISOString(),
        filePath: "/tmp/a.json",
        sha256: "abc",
        contentType: "application/json",
        sizeBytes: 10,
        metadata: {}
      }
    ],
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
}

describe("computeRiskScore", () => {
  it("produces deterministic severity", () => {
    const findings: EnricherOutput[] = [
      finding("RDAP", { domainAgeDays: 10 }),
      finding("VirusTotal API", { maliciousDetections: 8 }),
      finding("Blacklist/Reputation Check APIs", { hitCount: 2 }),
      finding("AbuseIPDB API", { maxAbuseConfidence: 90 }),
      finding("IPQualityScore (IPQS)", { maxFraudScore: 88 }),
      finding("Scamalytics API", { maxFraudScore: 86 })
    ];

    const result = computeRiskScore(findings);
    expect(result.total).toBeGreaterThan(60);
    expect(result.severity).toBe("CRITICAL");
  });
});
