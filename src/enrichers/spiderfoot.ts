import { createAdapter, firstDomain, firstEmail, firstUrl, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "SpiderFoot (active toggle)",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: true,
  collectionMethod: "active",
  async run(context) {
    if (!context.activeReconEnabled) {
      return skippedRun("Active recon disabled");
    }

    const target = firstDomain(context) ?? firstUrl(context) ?? firstEmail(context);
    if (!target) {
      return skippedRun("No target for SpiderFoot");
    }

    const hasSfCli = (await requireBinary("spiderfoot")) || (await requireBinary("sf.py"));
    if (!hasSfCli) {
      return skippedRun("SpiderFoot CLI not installed");
    }

    const modules =
      context.reconMode === "aggressive"
        ? "sfp_dnsresolve,sfp_dns,sfp_sslcert,sfp_shodan,sfp_crt,sfp_accounts,sfp_email,sfp_virustotal,sfp_urlscan,sfp_bgpview,sfp_mx,sfp_geoip"
        : "sfp_dnsresolve,sfp_dns,sfp_sslcert,sfp_shodan,sfp_crt,sfp_accounts,sfp_email,sfp_virustotal,sfp_urlscan";

    const command = (await requireBinary("spiderfoot"))
      ? `spiderfoot -s ${target} -m ${modules} -o json` 
      : `sf.py -s ${target} -m ${modules} -o json`;

    const result = await context.utilities.runCommand(command, 60_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());

    return {
      status: succeeded ? "ok" : "error",
      raw: {
        cmd: command,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        modules
      },
      summary: succeeded ? "SpiderFoot modules executed" : "SpiderFoot execution failed"
    };
  },
  parse(raw) {
    const stdout = String((raw as any)?.stdout ?? "").trim();
    let json: unknown = {};
    try {
      json = JSON.parse(stdout);
    } catch {
      json = { raw: stdout.slice(0, 4000) };
    }

    return {
      modules: (raw as any)?.modules,
      correlations: Array.isArray((json as any)?.results) ? (json as any).results.slice(0, 200) : [],
      summary: "SpiderFoot output normalized"
    };
  }
});
