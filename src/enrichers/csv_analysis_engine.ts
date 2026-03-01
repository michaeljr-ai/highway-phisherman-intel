import { promises as fs } from "node:fs";
import path from "node:path";
import { createAdapter, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Full CSV Analysis Engine (custom)",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run(context) {
    const csvPath = process.env.CSV_ARTIFACT_PATH;
    if (!csvPath) {
      return skippedRun("Out-of-scope/not provided: CSV artifact file was not provided");
    }

    const absolute = path.resolve(csvPath);
    try {
      const content = await fs.readFile(absolute, "utf8");
      return {
        status: "ok",
        raw: {
          csvPath: absolute,
          rowCount: content.split("\n").filter(Boolean).length,
          sample: content.split("\n").slice(0, 20)
        },
        summary: "CSV artifact parsed"
      };
    } catch {
      return skippedRun("CSV path provided but unreadable");
    }
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
