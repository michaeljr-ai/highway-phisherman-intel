import { createAdapter, listIps, safeTextFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Tor Check (Tor Project API)",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs available");
    }

    const checks: Array<{ ip: string; isExit: boolean }> = [];

    for (const ip of ips.slice(0, 25)) {
      try {
        const response = await safeTextFetch(
          context,
          `https://check.torproject.org/api/ip?ip=${encodeURIComponent(ip)}`
        );
        const parsed = JSON.parse(response) as { IsTor?: boolean };
        checks.push({ ip, isExit: Boolean(parsed.IsTor) });
      } catch {
        checks.push({ ip, isExit: false });
      }
    }

    return {
      status: "ok",
      endpoint: "https://check.torproject.org/api/ip",
      raw: { checks },
      summary: "Tor exit-node checks completed"
    };
  },
  parse(raw) {
    const checks = (raw as { checks?: Array<{ ip: string; isExit: boolean }> }).checks ?? [];
    return {
      checks,
      exitCount: checks.filter((c) => c.isExit).length
    };
  }
});
