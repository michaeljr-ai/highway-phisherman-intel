import { describe, expect, test } from "vitest";
import { buildToolReadinessReport } from "../src/core/tool_readiness.js";
import { EnricherOutput } from "../src/core/types.js";

function finding(toolName: string, status: EnricherOutput["status"], summary: string): EnricherOutput {
  return {
    toolName,
    status,
    summary,
    parsed: {},
    artifacts: [],
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

describe("tool readiness report", () => {
  test("classifies required tools with deterministic readiness buckets", () => {
    const report = buildToolReadinessReport([
      finding("RDAP", "ok", "RDAP complete"),
      finding("Highway Identity Alert Database", "disabled", "Out-of-scope / not provided"),
      finding("Subfinder", "skipped", "subfinder binary not installed"),
      finding("Wayback Machine / Internet Archive API", "skipped", "Wayback rate limited: HTTP 429 Too Many Requests"),
      finding("Shodan API", "not_configured", "Shodan API key missing"),
      finding("OSINT Framework", "ok", "Reference mapped")
    ]);

    expect(report.requiredCount).toBe(55);
    expect(report.coveragePass).toBe(true);
    expect(report.counts.ran_ok).toBeGreaterThanOrEqual(2);
    expect(report.counts.disabled_out_of_scope).toBeGreaterThanOrEqual(1);
    expect(report.counts.skipped_dependency).toBeGreaterThanOrEqual(1);
    expect(report.counts.skipped_rate_limited).toBeGreaterThanOrEqual(1);
    expect(report.counts.not_configured).toBeGreaterThanOrEqual(1);
  });
});
