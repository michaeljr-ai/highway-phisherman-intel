import { promises as fs } from "node:fs";
import path from "node:path";
import { createAdapter, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Visa/Immigration Fraud Methodology Research",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run() {
    const docPath = process.env.METHODOLOGY_DOC_PATH;
    if (!docPath) {
      return skippedRun("Not provided: optional contextual appendix requires user-supplied document content");
    }

    const absolute = path.resolve(docPath);
    const content = await fs.readFile(absolute, "utf8");

    return {
      status: "ok",
      raw: {
        path: absolute,
        content
      },
      summary: "User-supplied methodology appendix ingested"
    };
  },
  parse(raw) {
    const content = String((raw as any)?.content ?? "");
    return {
      provided: Boolean(content),
      excerpt: content.slice(0, 2000)
    };
  }
});
