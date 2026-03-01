import { resolveMx } from "node:dns/promises";
import { createAdapter, firstDomain, skippedRun } from "./_factory.js";

function classifyMx(exchange: string): string {
  const value = exchange.toLowerCase();
  if (value.includes("google")) return "Google Workspace";
  if (value.includes("outlook") || value.includes("protection.outlook")) return "Microsoft 365";
  if (value.includes("zoho")) return "Zoho";
  if (value.includes("proton")) return "Proton";
  return "Other/Custom";
}

export default createAdapter({
  tool_name: "DNS MX Record Lookup",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain available");
    }

    try {
      const mx = await resolveMx(domain);
      return {
        status: "ok",
        raw: {
          domain,
          mx
        },
        summary: `MX lookup returned ${mx.length} records`
      };
    } catch {
      return {
        status: "ok",
        raw: {
          domain,
          mx: []
        },
        summary: "No MX records"
      };
    }
  },
  parse(raw) {
    const records = ((raw as { mx?: Array<{ exchange: string; priority: number }> }).mx ?? []).map((record) => ({
      ...record,
      provider: classifyMx(record.exchange)
    }));

    return {
      noMx: records.length === 0,
      records,
      providers: Array.from(new Set(records.map((r) => r.provider)))
    };
  }
});
