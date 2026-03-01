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
  tool_name: "Scamalytics API",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "scamalytics")) {
      return notConfiguredRun("Scamalytics API key missing");
    }
    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs");
    }

    const records = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `https://api.scamalytics.com/v1/ip/${encodeURIComponent(ip)}?key=${encodeURIComponent(getApiKey(context, "scamalytics"))}`;
      const data = await safeJsonFetch(context, endpoint);
      records.push({ ip, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.scamalytics.com/v1/ip/{ip}",
      raw: { records },
      summary: "Scamalytics checks completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    const scores = records.map((r: any) => Number(r.data?.fraud_score ?? 0));
    return {
      records: records.map((r: any) => ({ ip: r.ip, fraudScore: r.data?.fraud_score, flags: r.data?.details ?? {} })),
      maxFraudScore: scores.length ? Math.max(...scores) : 0
    };
  }
});
