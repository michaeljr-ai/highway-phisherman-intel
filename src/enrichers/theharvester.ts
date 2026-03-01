import { createAdapter, firstDomain, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "theHarvester",
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
    if (!(await requireBinary("theHarvester")) && !(await requireBinary("theharvester"))) {
      return skippedRun("theHarvester binary not installed");
    }

    const cmd = (await requireBinary("theHarvester"))
      ? `theHarvester -d ${domain} -b all -f /tmp/theharvester-${context.caseId}`
      : `theharvester -d ${domain} -b all -f /tmp/theharvester-${context.caseId}`;

    const result = await context.utilities.runCommand(cmd, 60_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());
    const failureReason = `theHarvester command exited ${result.code}${
      result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 180)}` : ""
    }`;

    return {
      status: succeeded ? "ok" : "skipped",
      statusReason: succeeded ? undefined : failureReason,
      raw: {
        cmd,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      },
      summary: succeeded ? "theHarvester collection completed" : failureReason
    };
  },
  parse(raw) {
    const output = `${(raw as any)?.stdout ?? ""}\n${(raw as any)?.stderr ?? ""}`;
    const emails = Array.from(new Set((output.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((v) => v.toLowerCase())));
    const hosts = Array.from(new Set(output.match(/\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\b/g) ?? []));
    return {
      emails,
      hosts,
      emailCount: emails.length,
      hostCount: hosts.length
    };
  }
});
