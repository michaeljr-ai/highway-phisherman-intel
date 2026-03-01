import {
  createAdapter,
  getApiKey,
  hasApiKey,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Shodan Organization/SSL Search",
  inputs_required: ["domain"],
  can_run_from: ["domain", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "shodan")) {
      return notConfiguredRun("Shodan API key missing");
    }

    const orgHint = Object.values(context.scope.findings)
      .flatMap((finding) => {
        const orgs = finding.parsed.orgs;
        if (!Array.isArray(orgs)) return [];
        return orgs.map(String);
      })
      .find(Boolean);

    const certHint = Array.from(context.scope.certFingerprints)[0];

    if (!orgHint && !certHint) {
      return skippedRun("No discovered org/cert hint for Shodan advanced search");
    }

    const key = getApiKey(context, "shodan");
    const queries = [
      orgHint ? `org:"${orgHint}"` : null,
      certHint ? `ssl.cert.fingerprint:${certHint}` : null
    ].filter(Boolean) as string[];

    const results = [];
    for (const query of queries) {
      const endpoint = `https://api.shodan.io/shodan/host/search?key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`;
      const data = await safeJsonFetch(context, endpoint);
      results.push({ query, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.shodan.io/shodan/host/search",
      raw: { results },
      summary: "Shodan advanced org/SSL search completed"
    };
  },
  parse(raw) {
    const results = (raw as any)?.results ?? [];
    return {
      queries: results.map((r: any) => r.query),
      matchCount: results.reduce((sum: number, r: any) => sum + Number(r.data?.total ?? 0), 0)
    };
  }
});
