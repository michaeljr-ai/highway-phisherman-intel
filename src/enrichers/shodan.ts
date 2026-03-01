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
  tool_name: "Shodan API",
  inputs_required: ["domain"],
  can_run_from: ["domain", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    const ips = listIps(context);
    const hasKey = hasApiKey(context, "shodan");
    const key = hasKey ? getApiKey(context, "shodan") : "";

    if (!domain && ips.length === 0) {
      return skippedRun("No domain/IP in scope");
    }

    if (!hasKey) {
      if (ips.length === 0) {
        return notConfiguredRun("Shodan API key missing and no IPs available for InternetDB fallback");
      }

      const internetdbRecords: unknown[] = [];
      for (const ip of ips.slice(0, 10)) {
        const endpoint = `https://internetdb.shodan.io/${encodeURIComponent(ip)}`;
        try {
          const data = await safeJsonFetch(context, endpoint);
          internetdbRecords.push({ ip, data });
        } catch {
          internetdbRecords.push({ ip, data: { error: "failed" } });
        }
      }

      return {
        status: "ok",
        endpoint: "https://internetdb.shodan.io",
        raw: {
          hostRecords: [],
          domainData: {},
          internetdbRecords,
          fallback: "internetdb"
        },
        summary: "Shodan InternetDB fallback intelligence collected (limited fields)"
      };
    }

    const hostRecords: unknown[] = [];
    for (const ip of ips.slice(0, 10)) {
      const endpoint = `https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`;
      try {
        const data = await safeJsonFetch(context, endpoint);
        hostRecords.push({ ip, data });
      } catch {
        hostRecords.push({ ip, data: { error: "failed" } });
      }
    }

    let domainData: unknown = {};
    if (domain) {
      const endpoint = `https://api.shodan.io/dns/domain/${encodeURIComponent(domain)}?key=${encodeURIComponent(key)}`;
      try {
        domainData = await safeJsonFetch(context, endpoint);
      } catch {
        domainData = { error: "failed" };
      }
    }

    return {
      status: "ok",
      endpoint: "https://api.shodan.io",
      raw: {
        hostRecords,
        domainData
      },
      summary: "Shodan host/domain intelligence collected"
    };
  },
  parse(raw) {
    const hostRecords = (raw as { hostRecords?: Array<{ ip: string; data: any }> }).hostRecords ?? [];
    const domainData = (raw as { domainData?: any }).domainData ?? {};
    const internetdbRecords = (raw as { internetdbRecords?: Array<{ ip: string; data: any }> }).internetdbRecords ?? [];

    const ports = [
      ...hostRecords.flatMap((h) => (Array.isArray(h.data?.ports) ? h.data.ports : [])),
      ...internetdbRecords.flatMap((h) => (Array.isArray(h.data?.ports) ? h.data.ports : []))
    ];
    const htmlHashes = hostRecords
      .flatMap((h) => (Array.isArray(h.data?.data) ? h.data.data : []))
      .map((entry) => entry?.http?.html_hash)
      .filter(Boolean)
      .map(String);

    const certFingerprints = hostRecords
      .flatMap((h) => (Array.isArray(h.data?.data) ? h.data.data : []))
      .map((entry) => entry?.ssl?.cert?.fingerprint?.sha256)
      .filter(Boolean)
      .map(String);

    return {
      ports: Array.from(new Set(ports)),
      htmlHashes: Array.from(new Set(htmlHashes)),
      certFingerprints: Array.from(new Set(certFingerprints)),
      hostnames: Array.from(new Set(hostRecords.flatMap((h) => h.data?.hostnames ?? []))),
      domainSubdomains: domainData?.subdomains ?? [],
      orgs: Array.from(new Set(hostRecords.map((h) => h.data?.org).filter(Boolean))),
      asns: Array.from(new Set(hostRecords.map((h) => h.data?.asn).filter(Boolean))),
      internetdbRecords,
      sharedHtmlHashWithFlagged: false
    };
  }
});
