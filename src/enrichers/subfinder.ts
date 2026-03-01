import { createAdapter, firstDomain, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Subfinder",
  inputs_required: ["domain"],
  can_run_from: ["domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (process.env.PASSIVE_CLI_RECON_ENABLED === "false") {
      return skippedRun("Passive CLI recon disabled (PASSIVE_CLI_RECON_ENABLED=false)");
    }

    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain in scope");
    }
    if (!(await requireBinary("subfinder"))) {
      return skippedRun("subfinder binary not installed");
    }

    const cmd = `subfinder -d ${domain} -silent`;
    const result = await context.utilities.runCommand(cmd, 45_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());

    return {
      status: succeeded ? "ok" : "error",
      raw: {
        cmd,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      },
      summary: succeeded ? "Subfinder passive subdomain discovery complete" : "Subfinder failed"
    };
  },
  parse(raw) {
    const subdomains = String((raw as any)?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);

    return {
      subdomains,
      count: subdomains.length
    };
  }
});
