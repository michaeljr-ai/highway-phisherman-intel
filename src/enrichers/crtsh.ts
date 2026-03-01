import { createAdapter, firstDomain, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "crt.sh",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain available");
    }

    const endpoint = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
    const raw = await safeJsonFetch(context, endpoint);

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "Certificate Transparency records collected"
    };
  },
  parse(raw) {
    const records = Array.isArray(raw) ? raw.slice(0, 500) : [];
    const certFingerprints = Array.from(
      new Set(
        records
          .map((r) => (r && typeof r === "object" ? (r as { min_cert_id?: string | number }).min_cert_id : undefined))
          .filter(Boolean)
          .map(String)
      )
    );

    const names = Array.from(
      new Set(
        records
          .map((r) => (r && typeof r === "object" ? (r as { name_value?: string }).name_value : ""))
          .filter(Boolean)
          .flatMap((name) => String(name).split("\n"))
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      )
    );

    const wildcardCount = names.filter((n) => n.startsWith("*."))?.length;

    return {
      recordCount: records.length,
      certFingerprints,
      sanDomains: names,
      wildcardCount,
      unrelatedDomainCertReuse: names.some((n) => !n.endsWith("." + names[0]?.split(".").slice(-2).join(".")))
    };
  }
});
