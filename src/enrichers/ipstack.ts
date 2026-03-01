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
  tool_name: "ipstack API",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "ipstack")) {
      return notConfiguredRun("ipstack API key missing");
    }

    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs");
    }

    const key = getApiKey(context, "ipstack");
    const records = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `http://api.ipstack.com/${encodeURIComponent(ip)}?access_key=${encodeURIComponent(key)}&security=1`;
      const data = await safeJsonFetch(context, endpoint);
      records.push({ ip, data });
    }

    return {
      status: "ok",
      endpoint: "http://api.ipstack.com/{ip}",
      raw: { records },
      summary: "ipstack checks completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    return {
      records: records.map((r: any) => ({
        ip: r.ip,
        continent: r.data?.continent_name,
        country: r.data?.country_name,
        city: r.data?.city,
        connectionType: r.data?.connection?.type,
        isp: r.data?.connection?.isp,
        proxy: r.data?.security?.is_proxy,
        tor: r.data?.security?.is_tor
      }))
    };
  }
});
