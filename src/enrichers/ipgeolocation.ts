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
  tool_name: "IPGeolocation API",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "ipgeolocation")) {
      return notConfiguredRun("IPGeolocation API key missing");
    }

    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs");
    }

    const key = getApiKey(context, "ipgeolocation");
    const records = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `https://api.ipgeolocation.io/ipgeo?apiKey=${encodeURIComponent(key)}&ip=${encodeURIComponent(ip)}`;
      const data = await safeJsonFetch(context, endpoint);
      records.push({ ip, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.ipgeolocation.io/ipgeo",
      raw: { records },
      summary: "IPGeolocation checks completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    return {
      records: records.map((r: any) => ({
        ip: r.ip,
        country: r.data?.country_name,
        state: r.data?.state_prov,
        city: r.data?.city,
        isp: r.data?.isp,
        organization: r.data?.organization,
        threat: r.data?.security
      }))
    };
  }
});
