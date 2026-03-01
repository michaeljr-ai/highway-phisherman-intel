import { createAdapter, firstEmail, requireBinary, skippedRun } from "./_factory.js";

const HIGH_RISK_KEYWORDS = ["fraud", "hack", "carding", "crypto", "forum", "vpn", "anon"];

export default createAdapter({
  tool_name: "Holehe",
  inputs_required: ["email"],
  can_run_from: ["email"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (process.env.PASSIVE_CLI_RECON_ENABLED === "false") {
      return skippedRun("Passive CLI recon disabled (PASSIVE_CLI_RECON_ENABLED=false)");
    }

    const email = firstEmail(context);
    if (!email) {
      return skippedRun("No email in scope");
    }

    if (!(await requireBinary("holehe"))) {
      return skippedRun("holehe binary not installed");
    }

    const cmd = `holehe ${email} --only-used --no-color`;
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
      summary: succeeded ? "Holehe checks completed" : "Holehe execution failed"
    };
  },
  parse(raw) {
    const lines = String((raw as any)?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const services = lines
      .filter((line) => line.startsWith("[+") || line.startsWith("[x") || line.startsWith("[!"))
      .map((line) => line.replace(/^\[[^\]]+\]\s*/, ""));

    const highRiskPlatformPresence = services.some((svc) =>
      HIGH_RISK_KEYWORDS.some((k) => svc.toLowerCase().includes(k))
    );

    return {
      services,
      confirmedCount: services.length,
      highRiskPlatformPresence
    };
  }
});
