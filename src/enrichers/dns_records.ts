import {
  resolve,
  resolve4,
  resolve6,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveSoa,
  resolveSrv,
  resolveTxt
} from "node:dns/promises";
import { createAdapter, firstDomain, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "DNS Records",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain available");
    }

    async function tryResolve<T>(fn: () => Promise<T>): Promise<T | null> {
      try {
        return await fn();
      } catch {
        return null;
      }
    }

    const a = await tryResolve(() => resolve4(domain));
    const aaaa = await tryResolve(() => resolve6(domain));
    const cname = await tryResolve(() => resolveCname(domain));
    const mx = await tryResolve(() => resolveMx(domain));
    const ns = await tryResolve(() => resolveNs(domain));
    const txt = await tryResolve(() => resolveTxt(domain));
    const soa = await tryResolve(() => resolveSoa(domain));
    const srv = await tryResolve(() => resolveSrv(`_sip._tcp.${domain}`));
    const any = await tryResolve(() => resolve(domain, "ANY"));

    return {
      status: "ok",
      raw: { domain, a, aaaa, cname, mx, ns, txt, soa, srv, any },
      summary: "DNS record enumeration completed"
    };
  },
  parse(raw) {
    const data = raw as Record<string, unknown>;
    const soa = data.soa as { nsname?: string; hostmaster?: string } | null;
    return {
      a: Array.isArray(data.a) ? data.a : [],
      aaaa: Array.isArray(data.aaaa) ? data.aaaa : [],
      cname: Array.isArray(data.cname) ? data.cname : [],
      mx: Array.isArray(data.mx) ? data.mx : [],
      ns: Array.isArray(data.ns) ? data.ns : [],
      txt: Array.isArray(data.txt) ? data.txt : [],
      soa,
      soaRnameLeak: Boolean(soa?.hostmaster),
      srv: Array.isArray(data.srv) ? data.srv : []
    };
  }
});
