import { promises as fs } from "node:fs";
import path from "node:path";
import { createAdapter, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "BMO Equipment Financing Court Records",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run() {
    const docketPath = process.env.BMO_DOCKET_INPUT;
    if (!docketPath) {
      return skippedRun("Disabled: user must provide docket links/documents explicitly");
    }

    const absolute = path.resolve(docketPath);
    const content = await fs.readFile(absolute, "utf8");

    return {
      status: "ok",
      raw: {
        path: absolute,
        content
      },
      summary: "User-provided BMO docket content ingested"
    };
  },
  parse(raw) {
    return {
      provided: true,
      excerpt: String((raw as any)?.content ?? "").slice(0, 2000)
    };
  }
});
