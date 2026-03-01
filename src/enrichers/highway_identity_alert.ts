import { createAdapter, disabledRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Highway Identity Alert Database",
  inputs_required: ["domain", "url", "email"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "derived",
  async run() {
    return disabledRun(
      "Out-of-scope / not provided: carrier identifiers required. Not applicable to domain/email/url scope unless internal alert mapping is provided."
    );
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
