import { Buffer } from "node:buffer";
import {
  createAdapter,
  firstDomain,
  getApiKey,
  hasApiKey,
  listIps,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Censys",
  inputs_required: ["domain"],
  can_run_from: ["domain", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "censysId") || !hasApiKey(context, "censysSecret")) {
      return notConfiguredRun("Censys API credentials missing");
    }

    const domain = firstDomain(context);
    const ips = listIps(context);
    if (!domain && ips.length === 0) {
      return skippedRun("No domain or IP available");
    }

    const auth = Buffer.from(`${getApiKey(context, "censysId")}:${getApiKey(context, "censysSecret")}`).toString("base64");
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    };

    const hostResults: unknown[] = [];
    for (const ip of ips.slice(0, 10)) {
      try {
        const data = await safeJsonFetch(context, `https://search.censys.io/api/v2/hosts/${ip}`, { headers });
        hostResults.push({ ip, data });
      } catch {
        hostResults.push({ ip, data: { status: "error" } });
      }
    }

    let certSearch: unknown = {};
    if (domain) {
      certSearch = await safeJsonFetch(context, "https://search.censys.io/api/v2/certificates/search", {
        method: "POST",
        headers,
        body: JSON.stringify({ q: domain, per_page: 25 })
      });
    }

    return {
      status: "ok",
      endpoint: "https://search.censys.io/api/v2",
      raw: {
        hostResults,
        certSearch
      },
      summary: "Censys host and certificate metadata collected"
    };
  },
  parse(raw) {
    const hostResults = (raw as { hostResults?: Array<{ ip: string; data: any }> }).hostResults ?? [];
    const certHits = (raw as { certSearch?: any }).certSearch?.result?.hits ?? [];

    const certFingerprints = certHits
      .map((hit: any) => hit?.parsed?.fingerprint_sha256)
      .filter(Boolean)
      .map(String);

    return {
      hostCount: hostResults.length,
      serviceCount: hostResults.reduce(
        (sum, host) => sum + (Array.isArray(host.data?.result?.services) ? host.data.result.services.length : 0),
        0
      ),
      certCount: certHits.length,
      certFingerprints
    };
  }
});
