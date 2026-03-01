import { reverse } from "node:dns/promises";
import { createAdapter, listIps, skippedRun } from "./_factory.js";

function classifyPtr(hostname: string): string {
  const value = hostname.toLowerCase();
  if (value.includes("static") || value.includes("pool")) return "Likely ISP/residential pattern";
  if (value.includes("ec2") || value.includes("compute")) return "Cloud/hosting pattern";
  if (value.includes("colo") || value.includes("datacenter")) return "Datacenter pattern";
  return "Unclassified";
}

export default createAdapter({
  tool_name: "Reverse DNS / PTR Records",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs available");
    }

    const ptr: Array<{ ip: string; hostnames: string[] }> = [];
    for (const ip of ips.slice(0, 25)) {
      try {
        const hostnames = await reverse(ip);
        ptr.push({ ip, hostnames });
      } catch {
        ptr.push({ ip, hostnames: [] });
      }
    }

    return {
      status: "ok",
      raw: { ptr },
      summary: "PTR lookup completed"
    };
  },
  parse(raw) {
    const ptr = ((raw as { ptr?: Array<{ ip: string; hostnames: string[] }> }).ptr ?? []).map((item) => ({
      ...item,
      classifications: item.hostnames.map(classifyPtr)
    }));

    return {
      ptr,
      totalWithPtr: ptr.filter((r) => r.hostnames.length > 0).length
    };
  }
});
