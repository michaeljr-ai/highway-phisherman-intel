import {
  createAdapter,
  firstDomain,
  firstEmail,
  getApiKey,
  hasApiKey,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Hunter.io API",
  inputs_required: ["domain"],
  can_run_from: ["domain", "email"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "hunter")) {
      return notConfiguredRun("Hunter API key missing");
    }

    const key = getApiKey(context, "hunter");
    const domain = firstDomain(context);
    const email = firstEmail(context);

    if (!domain && !email) {
      return skippedRun("No domain/email in scope");
    }

    const domainEndpoint = domain
      ? `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(key)}`
      : undefined;
    const verifierEndpoint = email
      ? `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(key)}`
      : undefined;

    const [domainData, verifierData] = await Promise.all([
      domainEndpoint ? safeJsonFetch(context, domainEndpoint) : Promise.resolve(null),
      verifierEndpoint ? safeJsonFetch(context, verifierEndpoint) : Promise.resolve(null)
    ]);

    return {
      status: "ok",
      endpoint: "https://api.hunter.io/v2",
      raw: {
        domainData,
        verifierData
      },
      summary: "Hunter domain + email intelligence collected"
    };
  },
  parse(raw) {
    const domainData = (raw as any)?.domainData?.data;
    const verifierData = (raw as any)?.verifierData?.data;

    return {
      pattern: domainData?.pattern,
      catchAll: Boolean(domainData?.accept_all || verifierData?.accept_all),
      disposable: verifierData?.disposable,
      deliverable: verifierData?.status,
      confidence: verifierData?.score,
      emails: (domainData?.emails ?? []).slice(0, 50)
    };
  }
});
