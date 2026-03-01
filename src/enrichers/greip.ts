import {
  createAdapter,
  getApiKey,
  hasApiKey,
  listIps,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Greip API",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "greip")) {
      return notConfiguredRun("Greip API key missing");
    }

    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs");
    }

    const key = getApiKey(context, "greip");
    const records = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `https://api.greip.io/ip-lookup/${encodeURIComponent(ip)}?apiKey=${encodeURIComponent(key)}`;
      const data = await safeJsonFetch(context, endpoint);
      records.push({ ip, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.greip.io/ip-lookup/{ip}",
      raw: { records },
      summary: "Greip IP checks completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    const proxyFlags = records.filter((r: any) => Boolean(r.data?.data?.security?.proxy)).length;

    return {
      records: records.map((r: any) => ({
        ip: r.ip,
        country: r.data?.data?.country,
        asn: r.data?.data?.asn,
        proxy: r.data?.data?.security?.proxy,
        tor: r.data?.data?.security?.tor,
        threatLevel: r.data?.data?.security?.threat_level
      })),
      proxyFlags
    };
  }
});
