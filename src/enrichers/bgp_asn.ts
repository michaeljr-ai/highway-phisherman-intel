import { createAdapter, listIps, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "BGP/ASN Lookup",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs available");
    }

    const records: Array<{ ip: string; result: unknown }> = [];
    for (const ip of ips.slice(0, 20)) {
      try {
        const result = await safeJsonFetch(context, `https://api.bgpview.io/ip/${encodeURIComponent(ip)}`);
        records.push({ ip, result });
      } catch {
        records.push({ ip, result: { status: "error" } });
      }
    }

    return {
      status: "ok",
      endpoint: "https://api.bgpview.io/ip/{ip}",
      raw: { records },
      summary: "ASN metadata collected from BGPView"
    };
  },
  parse(raw) {
    const records = ((raw as { records?: Array<{ ip: string; result: any }> }).records ?? []).map((entry) => {
      const data = entry.result?.data;
      return {
        ip: entry.ip,
        asn: data?.prefixes?.[0]?.asn?.asn,
        asnName: data?.prefixes?.[0]?.asn?.name,
        description: data?.prefixes?.[0]?.asn?.description,
        prefix: data?.prefixes?.[0]?.prefix,
        classification:
          typeof data?.prefixes?.[0]?.asn?.description === "string" &&
          /mobile|telecom|broadband|fiber/i.test(data.prefixes[0].asn.description)
            ? "residential_or_isp"
            : "hosting_or_enterprise"
      };
    });

    return {
      records,
      asns: Array.from(new Set(records.map((r) => r.asn).filter(Boolean)))
    };
  }
});
