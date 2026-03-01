import { promises as fs } from "node:fs";
import path from "node:path";
import { createAdapter, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "FMCSA IP Cross-Referencing (Highway internal)",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email", "derived_ip"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run() {
    const mappingPath = process.env.FMCSA_IP_MAPPING_FILE;
    if (!mappingPath) {
      return skippedRun("Out-of-scope: internal logs/mapping file not provided");
    }

    const absolute = path.resolve(mappingPath);
    const content = await fs.readFile(absolute, "utf8");

    return {
      status: "ok",
      raw: {
        path: absolute,
        content
      },
      summary: "User-provided FMCSA IP mapping ingested"
    };
  },
  parse(raw) {
    const content = String((raw as any)?.content ?? "");
    return {
      provided: true,
      lineCount: content.split("\n").filter(Boolean).length
    };
  }
});
