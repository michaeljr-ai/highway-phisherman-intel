import { createAdapter, listUsernames, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Maigret",
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
      return skippedRun("No derived usernames in scope");
    }
    if (!(await requireBinary("maigret"))) {
      return skippedRun("maigret binary not installed");
    }

    const cmd = `maigret ${usernames[0]} --no-progressbar --json`;
    const result = await context.utilities.runCommand(cmd, 45_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());
    const failureReason = `Maigret command exited ${result.code}${
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
      summary: succeeded ? "Maigret scan completed" : failureReason
    };
  },
  parse(raw) {
    const out = String((raw as any)?.stdout ?? "").trim();
    try {
      const json = JSON.parse(out);
      const urls = Object.values(json?.sites ?? {})
        .map((entry: any) => entry?.url_user)
        .filter(Boolean);
      return {
        confirmedCount: urls.length,
        profileUrls: urls.slice(0, 300)
      };
    } catch {
      const urls = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^https?:\/\//.test(line));
      return {
        confirmedCount: urls.length,
        profileUrls: urls
      };
    }
  }
});
