import { createAdapter, firstDomain, firstUrl, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "wafw00f",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url"],
  defaultEnabled: true,
  collectionMethod: "active",
  async run(context) {
    if (!context.activeReconEnabled) {
      return skippedRun("Active recon disabled");
    }

    const target = firstUrl(context) ?? (firstDomain(context) ? `https://${firstDomain(context)}` : undefined);
    if (!target) {
      return skippedRun("No target URL/domain in scope");
    }

    if (!(await requireBinary("wafw00f"))) {
      return skippedRun("wafw00f binary not installed");
    }

    const cmd = `wafw00f ${target} -a`;
    const result = await context.utilities.runCommand(cmd, 30_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());
    const failureReason = `wafw00f command exited ${result.code}${
      result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 180)}` : ""
    }`;

    return {
      status: succeeded ? "ok" : "skipped",
      statusReason: succeeded ? undefined : failureReason,
      toolVersion: "cli",
      raw: {
        cmd,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      },
      summary: succeeded ? "WAF fingerprinting complete" : failureReason
    };
  },
  parse(raw) {
    const out = String((raw as any)?.stdout ?? "");
    const vendorLine = out
      .split("\n")
      .find((line) => line.includes("is behind") || line.includes("WAF"))
      ?.trim();

    return {
      wafDetected: Boolean(vendorLine),
      vendor: vendorLine,
      confidence: vendorLine ? 0.7 : 0.2
    };
  }
});
