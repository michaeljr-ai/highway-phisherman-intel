import { resolveTxt } from "node:dns/promises";
import { createAdapter, firstDomain, skippedRun } from "./_factory.js";

function flattenTxt(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(""));
}

export default createAdapter({
  tool_name: "DNS TXT/SPF/DMARC Analysis",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain available");
    }

    let txt: string[] = [];
    let dmarc: string[] = [];

    try {
      txt = flattenTxt(await resolveTxt(domain));
    } catch {
      txt = [];
    }

    try {
      dmarc = flattenTxt(await resolveTxt(`_dmarc.${domain}`));
    } catch {
      dmarc = [];
    }

    return {
      status: "ok",
      raw: {
        domain,
        txt,
        dmarc
      },
      summary: "SPF/DMARC policy analysis complete"
    };
  },
  parse(raw) {
    const data = raw as { txt?: string[]; dmarc?: string[] };
    const txt = data.txt ?? [];
    const dmarc = data.dmarc ?? [];

    const spf = txt.find((record) => record.toLowerCase().startsWith("v=spf1"));
    const spfIncludes = spf ? [...spf.matchAll(/include:([^\s]+)/g)].map((m) => m[1]) : [];

    const dmarcRecord = dmarc.find((record) => record.toLowerCase().includes("v=dmarc1"));
    const policy = dmarcRecord?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase() ?? "none";
    const weakPolicy = !spf || !dmarcRecord || policy === "none";

    return {
      spf,
      spfIncludes,
      dmarc: dmarcRecord,
      dmarcPolicy: policy,
      weakPolicy,
      leakedHostnames: spfIncludes.filter((host) => host.split(".").length > 2)
    };
  }
});
