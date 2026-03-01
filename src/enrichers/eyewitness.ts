import path from "node:path";
import { createAdapter, firstDomain, firstUrl, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "EyeWitness (active toggle)",
  inputs_required: ["url"],
  can_run_from: ["url", "domain"],
  defaultEnabled: true,
  collectionMethod: "active",
  async run(context) {
    if (!context.activeReconEnabled) {
      return skippedRun("Active recon disabled");
    }
    if (!(await requireBinary("EyeWitness")) && !(await requireBinary("eyewitness"))) {
      return skippedRun("EyeWitness binary not installed");
    }

    const target = firstUrl(context) ?? (firstDomain(context) ? `https://${firstDomain(context)}` : undefined);
    if (!target) {
      return skippedRun("No target URL/domain");
    }

    const outputDir = path.join(context.config.outputRoot, context.caseId, "eyewitness_tmp");
    const command = (await requireBinary("EyeWitness"))
      ? `EyeWitness --web -f <(echo '${target}') --no-prompt -d '${outputDir}'`
      : `eyewitness --web -f <(echo '${target}') --no-prompt -d '${outputDir}'`;

    const result = await context.utilities.runCommand(command, 60_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());
    const failureReason = `EyeWitness command exited ${result.code}${
      result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 180)}` : ""
    }`;

    return {
      status: succeeded ? "ok" : "skipped",
      statusReason: succeeded ? undefined : failureReason,
      raw: {
        cmd: command,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        outputDir
      },
      summary: succeeded ? "EyeWitness capture completed" : failureReason
    };
  },
  parse(raw) {
    return {
      outputDir: (raw as any)?.outputDir,
      note: "Screenshots stored in artifacts when available"
    };
  }
});
