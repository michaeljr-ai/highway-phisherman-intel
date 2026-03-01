import { createAdapter, listIps, requireBinary, skippedRun } from "./_factory.js";

function profileToArgs(profile: string): string {
  switch (profile) {
    case "AGGRESSIVE":
      return "-sT -sV -sC --top-ports 1000 --max-retries 1 --host-timeout 90s --min-rate 1000";
    case "FULL_TCP":
      return "-sT -p-";
    case "SERVICE_ENUM":
      return "-sV -sC";
    default:
      return "-T4 --top-ports 100";
  }
}

export default createAdapter({
  tool_name: "Nmap (authorized; active toggle)",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip"],
  defaultEnabled: true,
  collectionMethod: "active",
  async run(context) {
    if (!context.activeReconEnabled) {
      return skippedRun("Active recon disabled");
    }
    if (!(await requireBinary("nmap"))) {
      return skippedRun("nmap binary not installed");
    }

    const ips = listIps(context);
    if (ips.length === 0) {
      return skippedRun("No derived IPs available");
    }

    const profile = context.reconMode === "aggressive" ? "AGGRESSIVE" : process.env.NMAP_PROFILE ?? "FAST";
    const args = profileToArgs(profile);
    const cmd = `nmap ${args} -oX - ${ips.slice(0, 10).join(" ")}`;
    const result = await context.utilities.runCommand(cmd, 60_000);
    const succeeded = result.code === 0 || /<nmaprun[\s>]/i.test(result.stdout);
    const failureReason = `Nmap command exited ${result.code}${
      result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 180)}` : ""
    }`;

    return {
      status: succeeded ? "ok" : "skipped",
      statusReason: succeeded ? undefined : failureReason,
      toolVersion: "cli",
      raw: {
        cmd,
        code: result.code,
        xml: result.stdout,
        stderr: result.stderr,
        profile
      },
      summary: succeeded ? "Nmap scan completed" : failureReason
    };
  },
  parse(raw) {
    const xml = String((raw as any)?.xml ?? "");
    const openPorts = [...xml.matchAll(/<port protocol="([^"]+)" portid="([^"]+)">[\s\S]*?<state state="open"/g)].map(
      (match) => ({
        protocol: match[1],
        port: Number(match[2])
      })
    );

    return {
      profile: (raw as any)?.profile,
      openPorts,
      openPortCount: openPorts.length
    };
  }
});
