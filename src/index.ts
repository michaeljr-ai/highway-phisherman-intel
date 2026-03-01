import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "./core/config.js";
import { createInvestigationInput } from "./core/normalize.js";
import { runInvestigation } from "./core/orchestrator.js";

interface CliArgs {
  inputs: string[];
  activeRecon: boolean;
  tlp?: string;
  output?: string;
}

function normalizeTlp(value: string, fallback: string): string {
  const normalized = value.trim().toUpperCase();
  if (["TLP:RED", "TLP:AMBER", "TLP:GREEN", "TLP:CLEAR"].includes(normalized)) {
    return normalized;
  }
  return fallback.toUpperCase();
}

function reconModeFromTlp(tlp: string): "standard" | "aggressive" {
  return tlp === "TLP:RED" ? "aggressive" : "standard";
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    inputs: [],
    activeRecon: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input" && argv[i + 1]) {
      parsed.inputs.push(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith("--input=")) {
      parsed.inputs.push(arg.slice("--input=".length));
      continue;
    }

    if (arg === "--active" && argv[i + 1]) {
      parsed.activeRecon = ["1", "true", "yes"].includes(argv[i + 1].toLowerCase());
      i += 1;
      continue;
    }

    if (arg.startsWith("--active=")) {
      parsed.activeRecon = ["1", "true", "yes"].includes(arg.slice("--active=".length).toLowerCase());
      continue;
    }

    if (arg === "--tlp" && argv[i + 1]) {
      parsed.tlp = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--tlp=")) {
      parsed.tlp = arg.slice("--tlp=".length);
      continue;
    }

    if (arg === "--output" && argv[i + 1]) {
      parsed.output = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
      continue;
    }

    if (!arg.startsWith("--")) {
      parsed.inputs.push(arg);
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (args.output) {
    config.outputRoot = path.resolve(args.output);
  }

  if (args.inputs.length === 0) {
    console.error("Usage: npm run start -- --input example.com --input https://example.com --input user@example.com [--active=true]");
    process.exitCode = 1;
    return;
  }

  const tlp = normalizeTlp(args.tlp ?? config.defaultTlp, config.defaultTlp);
  const reconMode = reconModeFromTlp(tlp);
  const input = createInvestigationInput(args.inputs, tlp);

  const result = await runInvestigation(input, config, {
    activeRecon: reconMode === "aggressive" ? true : args.activeRecon,
    reconMode
  });

  const summary = {
    case_id: result.caseId,
    severity: result.score.severity,
    score: result.score.total,
    confidence_pct: result.score.confidencePct,
    report_html: result.reportHtmlPath,
    evidence_json: result.evidenceJsonPath,
    audit_log: result.auditJsonPath,
    tool_runs: result.enrichments.length
  };

  const summaryPath = path.join(path.dirname(result.reportHtmlPath), "run_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
