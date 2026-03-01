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
  tool_name: "AbuseIPDB API",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "abuseipdb")) {
      return notConfiguredRun("AbuseIPDB API key missing");
    }
    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs");
    }

    const headers = {
      Key: getApiKey(context, "abuseipdb"),
      Accept: "application/json"
    };

    const records = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`;
      const data = await safeJsonFetch(context, endpoint, { headers });
      records.push({ ip, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.abuseipdb.com/api/v2/check",
      raw: { records },
      summary: "AbuseIPDB checks completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    const confidence = records.map((r: any) => Number(r.data?.data?.abuseConfidenceScore ?? 0));

    return {
      records: records.map((r: any) => ({
        ip: r.ip,
        abuseConfidenceScore: r.data?.data?.abuseConfidenceScore,
        totalReports: r.data?.data?.totalReports,
        isp: r.data?.data?.isp,
        usageType: r.data?.data?.usageType
      })),
      maxAbuseConfidence: confidence.length ? Math.max(...confidence) : 0
    };
  }
});
