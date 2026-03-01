import { createAdapter, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "IP Geolocation (ipinfo/MaxMind/multi-source)",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "derived",
  async run(context) {
    const ipstack = context.scope.findings["ipstack API"];
    const ipgeo = context.scope.findings["IPGeolocation API"];
    const greip = context.scope.findings["Greip API"];

    if (!ipstack && !ipgeo && !greip) {
      return skippedRun("No underlying geolocation findings available");
    }

    return {
      status: "ok",
      raw: {
        ipstack: ipstack?.parsed,
        ipgeolocation: ipgeo?.parsed,
        greip: greip?.parsed,
        maxmindConfigured: Boolean(context.config.apiKeys.maxmind)
      },
      summary: "Multi-source geolocation aggregation completed"
    };
  },
  parse(raw) {
    const merged: Record<string, Record<string, unknown>> = {};

    const sources = ["ipstack", "ipgeolocation", "greip"] as const;
    for (const source of sources) {
      const rows = (raw as any)?.[source]?.records ?? [];
      for (const row of rows) {
        const ip = row.ip;
        if (!ip) continue;
        merged[ip] = {
          ...(merged[ip] ?? {}),
          [source]: row
        };
      }
    }

    return {
      ipCount: Object.keys(merged).length,
      merged,
      maxmindConfigured: (raw as any)?.maxmindConfigured
    };
  }
});
