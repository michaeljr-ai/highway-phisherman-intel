import { createAdapter, listUsernames, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Blackbird",
  inputs_required: ["derived_username"],
  can_run_from: ["derived_username", "email"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (process.env.PASSIVE_CLI_RECON_ENABLED === "false") {
      return skippedRun("Passive CLI recon disabled (PASSIVE_CLI_RECON_ENABLED=false)");
    }

    const usernames = listUsernames(context);
    if (usernames.length === 0) {
      return skippedRun("No derived usernames available");
    }
    if (!(await requireBinary("blackbird"))) {
      return skippedRun("blackbird binary not installed");
    }

    const cmd = `blackbird --username ${usernames[0]} --csv`;
    const result = await context.utilities.runCommand(cmd, 30_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());
    const failureReason = `Blackbird command exited ${result.code}${
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
      summary: succeeded ? "Blackbird scan completed" : failureReason
    };
  },
  parse(raw) {
    const lines = String((raw as any)?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const urls = lines.filter((line) => line.includes("http://") || line.includes("https://"));

    return {
      confirmedCount: urls.length,
      profileUrls: urls.slice(0, 300)
    };
  }
});
