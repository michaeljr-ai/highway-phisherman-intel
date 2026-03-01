import {
  createAdapter,
  firstDomain,
  getApiKey,
  hasApiKey,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Host.io API",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "hostio")) {
      return notConfiguredRun("Host.io API key missing");
    }

    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain in scope");
    }

    const endpoint = `https://host.io/api/domain/${encodeURIComponent(domain)}?token=${encodeURIComponent(getApiKey(context, "hostio"))}`;
    const raw = await safeJsonFetch(context, endpoint);

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "Host.io relationship metadata collected"
    };
  },
  parse(raw) {
    const data = raw as any;
    return {
      ip: data?.ip,
      asn: data?.asn,
      provider: data?.provider,
      redirectsTo: data?.redirects_to ?? [],
      backlinks: data?.backlinks ?? [],
      relatedDomains: data?.related_domains ?? []
    };
  }
});
