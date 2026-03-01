import { createAdapter, safeJsonFetch, skippedRun } from "./_factory.js";

function discoveredCompany(context: any): string | undefined {
  for (const finding of Object.values(context.scope.findings) as any[]) {
    const orgs = Array.isArray(finding?.parsed?.orgs) ? finding.parsed.orgs : [];
    const names = Array.isArray(finding?.parsed?.discoveredCompanyNames) ? finding.parsed.discoveredCompanyNames : [];
    const merged = [...orgs, ...names].map(String).filter(Boolean);
    if (merged.length > 0) return merged[0];
  }
  return undefined;
}

export default createAdapter({
  tool_name: "SEC EDGAR",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "passive",
  async run(context) {
    const company = discoveredCompany(context);
    if (!company) {
      return skippedRun("Disabled: no discovered company name available for EDGAR search");
    }

    const endpoint = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(company)}&category=custom&forms=10-K,8-K`; // public endpoint
    const raw = await safeJsonFetch(context, endpoint, {
      headers: { "User-Agent": "highway-phisherman/1.0" }
    });

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "SEC EDGAR lookup completed"
    };
  },
  parse(raw) {
    const hits = (raw as any)?.hits?.hits ?? [];
    return {
      filingCount: hits.length,
      filings: hits.slice(0, 20)
    };
  }
});
