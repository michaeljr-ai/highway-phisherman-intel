import { createAdapter, disabledRun } from "./_factory.js";

export default createAdapter({
  tool_name: "FMCSA SAFER/Census API",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run() {
    return disabledRun(
      "Out-of-scope / not provided: structured carrier identifiers required. Disabled for strict domain/email/url scope."
    );
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
