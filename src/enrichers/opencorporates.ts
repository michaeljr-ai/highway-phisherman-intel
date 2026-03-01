import { createAdapter, safeJsonFetch, skippedRun } from "./_factory.js";

function discoveredCompany(context: any): string | undefined {
  for (const finding of Object.values(context.scope.findings) as any[]) {
    const candidates = [
      ...(Array.isArray(finding?.parsed?.discoveredCompanyNames) ? finding.parsed.discoveredCompanyNames : []),
      ...(Array.isArray(finding?.parsed?.orgs) ? finding.parsed.orgs : [])
    ]
      .map(String)
      .filter(Boolean);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return undefined;
}

export default createAdapter({
  tool_name: "OpenCorporates API",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "passive",
  async run(context) {
    const company = discoveredCompany(context);
    if (!company) {
      return skippedRun("Disabled: no discovered company name from WHOIS/RDAP/site content");
    }

    const endpoint = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(company)}`;
    let raw: unknown;
    try {
      raw = await safeJsonFetch(context, endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("401")) {
        return {
          status: "not_configured",
          statusReason: "OpenCorporates API key not configured or unauthorized",
          raw: { message },
          summary: "OpenCorporates not configured"
        };
      }
      throw error;
    }

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "OpenCorporates lookup completed"
    };
  },
  parse(raw) {
    const companies = (raw as any)?.results?.companies ?? [];
    return {
      companyCount: companies.length,
      companies: companies.slice(0, 25)
    };
  }
});
