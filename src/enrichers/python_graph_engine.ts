import path from "node:path";
import { promises as fs } from "node:fs";
import { createAdapter } from "./_factory.js";

export default createAdapter({
  tool_name: "Python Graph-Theoretic Analysis Engine (custom)",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email", "derived_ip", "derived_username"],
  defaultEnabled: true,
  collectionMethod: "derived",
  async run(context) {
    const workDir = path.join(context.config.outputRoot, context.caseId);
    await fs.mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, "python_graph_input.json");
    const outputPath = path.join(workDir, "python_graph_output.json");

    const payload = {
      domains: Array.from(context.scope.domains),
      urls: Array.from(context.scope.urls),
      emails: Array.from(context.scope.emails),
      ips: Array.from(context.scope.ips),
      usernames: Array.from(context.scope.usernames),
      certs: Array.from(context.scope.certFingerprints)
    };

    await fs.writeFile(inputPath, JSON.stringify(payload), "utf8");

    const cmd = `python3 scripts/python_graph_engine.py --input '${inputPath}' --output '${outputPath}'`;
    const result = await context.utilities.runCommand(cmd, 90_000);

    let parsedOutput: unknown = {};
    if (result.code === 0) {
      try {
        parsedOutput = JSON.parse(await fs.readFile(outputPath, "utf8"));
      } catch {
        parsedOutput = {};
      }
    }

    return {
      status: result.code === 0 ? "ok" : "error",
      raw: {
        cmd,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        output: parsedOutput
      },
      summary: result.code === 0 ? "Python graph analytics completed" : "Python graph analytics failed"
    };
  },
  parse(raw) {
    return {
      metrics: (raw as any)?.output?.metrics ?? {},
      correlationStrength: (raw as any)?.output?.correlation_strength ?? []
    };
  }
});
