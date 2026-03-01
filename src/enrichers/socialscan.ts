import { createAdapter, firstEmail, listUsernames, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Socialscan",
  inputs_required: ["email"],
  can_run_from: ["email", "derived_username"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (process.env.PASSIVE_CLI_RECON_ENABLED === "false") {
      return skippedRun("Passive CLI recon disabled (PASSIVE_CLI_RECON_ENABLED=false)");
    }

    const email = firstEmail(context);
    const username = listUsernames(context)[0];
    if (!email && !username) {
      return skippedRun("No email/username in scope");
    }
    if (!(await requireBinary("socialscan"))) {
      return skippedRun("socialscan binary not installed");
    }

    const targets = [email, username].filter(Boolean).join(" ");
    const cmd = `socialscan ${targets}`;
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
      summary: succeeded ? "Socialscan checks completed" : "Socialscan execution failed"
    };
  },
  parse(raw) {
    const lines = String((raw as any)?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const positives = lines.filter((line) => /exists|taken|registered|used/i.test(line));
    return {
      confirmedCount: positives.length,
      findings: positives.slice(0, 200)
    };
  }
});
