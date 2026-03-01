import path from "node:path";
import { promises as fs } from "node:fs";
import { createAdapter, requireBinary, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Rust Graph Engine (custom compiled)",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email", "derived_ip", "derived_username"],
  defaultEnabled: true,
  collectionMethod: "derived",
  async run(context) {
    const binaryPath = path.resolve("./target/release/rust_graph_engine");
    const workDir = path.join(context.config.outputRoot, context.caseId);
    await fs.mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, "rust_graph_input.json");
    const outputPath = path.join(workDir, "rust_graph_output.json");

    const payload = {
      domains: Array.from(context.scope.domains),
      urls: Array.from(context.scope.urls),
      emails: Array.from(context.scope.emails),
      ips: Array.from(context.scope.ips),
      usernames: Array.from(context.scope.usernames),
      certs: Array.from(context.scope.certFingerprints)
    };

    await fs.writeFile(inputPath, JSON.stringify(payload), "utf8");

    let cmd = `'${binaryPath}' --input '${inputPath}' --output '${outputPath}'`;
    let result;
    let fallback = false;

    if (await requireBinary(binaryPath)) {
      result = await context.utilities.runCommand(cmd, 90_000);
    } else {
      fallback = true;
      cmd = `python3 scripts/python_graph_engine.py --input '${inputPath}' --output '${outputPath}'`;
      result = await context.utilities.runCommand(cmd, 90_000);
    }

    let output: unknown = {};
    if (result.code === 0) {
      try {
        output = JSON.parse(await fs.readFile(outputPath, "utf8"));
      } catch {
        output = {};
      }
    }

    return {
      status: result.code === 0 ? "ok" : "error",
      raw: {
        cmd,
        fallback,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        output
      },
      summary:
        result.code === 0
          ? fallback
            ? "Rust graph engine fallback completed via Python compatibility path"
            : "Rust graph engine completed"
          : "Rust graph engine failed"
    };
  },
  parse(raw) {
    return {
      metrics: (raw as any)?.output?.metrics ?? {},
      correlationStrength: (raw as any)?.output?.correlation_strength ?? []
    };
  }
});
