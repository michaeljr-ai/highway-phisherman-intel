import {
  createAdapter,
  firstDomain,
  firstUrl,
  getApiKey,
  hasApiKey,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "VirusTotal API",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "virustotal")) {
      return notConfiguredRun("VirusTotal API key missing");
    }

    const key = getApiKey(context, "virustotal");
    const domain = firstDomain(context);
    const observedUrl = firstUrl(context);

    if (!domain && !observedUrl) {
      return skippedRun("No domain/url in scope");
    }

    const headers = { "x-apikey": key };
    const domainData = domain
      ? await safeJsonFetch(context, `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, { headers })
      : null;

    const urlId = observedUrl ? Buffer.from(observedUrl).toString("base64url") : null;
    const urlData = urlId
      ? await safeJsonFetch(context, `https://www.virustotal.com/api/v3/urls/${urlId}`, { headers })
      : null;

    return {
      status: "ok",
      endpoint: "https://www.virustotal.com/api/v3",
      raw: {
        domainData,
        urlData
      },
      summary: "VirusTotal domain/url intelligence collected"
    };
  },
  parse(raw) {
    const attrs = (raw as any)?.domainData?.data?.attributes ?? {};
    const domainStats = attrs?.last_analysis_stats ?? {};
    const urlStats = (raw as any)?.urlData?.data?.attributes?.last_analysis_stats ?? {};

    const maliciousDetections =
      Number(domainStats.malicious ?? 0) + Number(urlStats.malicious ?? 0) + Number(domainStats.suspicious ?? 0);

    const threatClass = attrs?.popular_threat_classification ?? {};
    const actorHints = Array.from(
      new Set(
        [
          threatClass?.suggested_threat_label,
          ...(Array.isArray(threatClass?.popular_threat_name) ? threatClass.popular_threat_name.map((v: any) => v?.value) : []),
          ...(Array.isArray(threatClass?.popular_threat_category)
            ? threatClass.popular_threat_category.map((v: any) => v?.value)
            : []),
          ...(Array.isArray(attrs?.tags) ? attrs.tags : [])
        ]
          .filter(Boolean)
          .map((value) => String(value))
      )
    );

    return {
      maliciousDetections,
      domainStats,
      urlStats,
      reputation: attrs?.reputation,
      popularityRanks: attrs?.popularity_ranks ?? {},
      whoisDate: attrs?.whois_date,
      categories: attrs?.categories ?? {},
      actorHints
    };
  }
});
