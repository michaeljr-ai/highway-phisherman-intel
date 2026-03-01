import { createAdapter, firstDomain, firstUrl, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Nuclei (active toggle)",
  inputs_required: ["url"],
  can_run_from: ["url", "domain"],
  defaultEnabled: true,
  collectionMethod: "active",
  async run(context) {
    if (!context.activeReconEnabled) {
      return skippedRun("Active recon disabled");
    }
    if (!(await requireBinary("nuclei"))) {
      return skippedRun("nuclei binary not installed");
    }

    const target = firstUrl(context) ?? (firstDomain(context) ? `https://${firstDomain(context)}` : undefined);
    if (!target) {
      return skippedRun("No URL/domain target available");
    }

    const cmd =
      context.reconMode === "aggressive"
        ? `nuclei -u ${target} -silent -jsonl -severity low,medium,high,critical -rl 150 -c 50`
        : `nuclei -u ${target} -silent -jsonl`;
    const result = await context.utilities.runCommand(cmd, 60_000);
    const succeeded = result.code === 0 || (result.code === 1 && !result.stderr.trim());

    return {
      status: succeeded ? "ok" : "error",
      raw: {
        cmd,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      },
      summary: succeeded ? "Nuclei checks completed" : "Nuclei execution failed"
    };
  },
  parse(raw) {
    const lines = String((raw as any)?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const hits = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    return {
      hitCount: hits.length,
      hits: hits.slice(0, 100)
    };
  }
});
