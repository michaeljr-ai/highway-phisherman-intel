import { createAdapter, firstDomain, listIps, safeJsonFetch, skippedRun } from "./_factory.js";

async function checkUrlhaus(context: Parameters<typeof safeJsonFetch>[0], host: string): Promise<any> {
  const response = await context.utilities.fetchJson("https://urlhaus-api.abuse.ch/v1/host/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `host=${encodeURIComponent(host)}`,
    signal: AbortSignal.timeout(25_000)
  });
  return response;
}

export default createAdapter({
  tool_name: "Blacklist/Reputation Check APIs",
  inputs_required: ["domain"],
  can_run_from: ["domain", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    const ips = listIps(context);
    if (!domain && ips.length === 0) {
      return skippedRun("No domain/IP in scope");
    }

    const checks: Array<{ target: string; source: string; result: unknown }> = [];

    if (domain) {
      try {
        checks.push({ target: domain, source: "urlhaus", result: await checkUrlhaus(context, domain) });
      } catch {
        checks.push({ target: domain, source: "urlhaus", result: { query_status: "error" } });
      }
    }

    for (const ip of ips.slice(0, 20)) {
      try {
        checks.push({ target: ip, source: "urlhaus", result: await checkUrlhaus(context, ip) });
      } catch {
        checks.push({ target: ip, source: "urlhaus", result: { query_status: "error" } });
      }
    }

    return {
      status: "ok",
      endpoint: "https://urlhaus-api.abuse.ch/v1/host/",
      raw: { checks },
      summary: "Reputation checks executed"
    };
  },
  parse(raw) {
    const checks = (raw as any)?.checks ?? [];
    const normalized = checks.map((entry: any) => {
      const payload = entry.result ?? {};
      return {
        target: entry.target,
        source: entry.source,
        query_status: payload.query_status,
        blacklist_hit: payload.query_status === "ok" && Number(payload.urls?.length ?? 0) > 0,
        references: payload.urls ?? []
      };
    });

    return {
      checks: normalized,
      hitCount: normalized.filter((item: any) => item.blacklist_hit).length
    };
  }
});
