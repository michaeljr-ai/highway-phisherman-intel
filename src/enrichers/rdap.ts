import { createAdapter, firstDomain, listIps, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "RDAP",
  inputs_required: ["domain"],
  can_run_from: ["domain", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain available");
    }

    const domainRdapUrl = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    const domainRaw = await safeJsonFetch(context, domainRdapUrl);

    const ipRdap: Array<{ ip: string; data: unknown }> = [];
    for (const ip of listIps(context).slice(0, 10)) {
      try {
        const data = await safeJsonFetch(context, `https://rdap.org/ip/${encodeURIComponent(ip)}`);
        ipRdap.push({ ip, data });
      } catch {
        // keep partial
      }
    }

    return {
      status: "ok",
      endpoint: domainRdapUrl,
      raw: { domain: domainRaw, ip: ipRdap },
      summary: "RDAP lifecycle and registration metadata collected"
    };
  },
  parse(raw) {
    const domain = (raw as { domain?: Record<string, unknown> }).domain ?? {};
    const events = Array.isArray(domain.events) ? domain.events : [];

    const created = events.find((e) => e && typeof e === "object" && (e as { eventAction?: string }).eventAction === "registration") as
      | { eventDate?: string }
      | undefined;
    const createdDate = created?.eventDate;
    const ageDays = createdDate ? Math.max(0, Math.floor((Date.now() - Date.parse(createdDate)) / 86_400_000)) : undefined;

    return {
      handle: domain.handle,
      status: domain.status,
      nameservers: Array.isArray(domain.nameservers)
        ? domain.nameservers
            .map((n) => (n && typeof n === "object" ? (n as { ldhName?: string }).ldhName : undefined))
            .filter(Boolean)
        : [],
      createdDate,
      domainAgeDays: ageDays,
      registrar: Array.isArray(domain.entities)
        ? domain.entities
            .map((e) => (e && typeof e === "object" ? (e as { roles?: string[]; vcardArray?: unknown[] }).roles : []))
            .flat()
            .filter(Boolean)
        : [],
      rawEventCount: events.length
    };
  }
});
