import { createAdapter, skippedRun } from "./_factory.js";

function hasNyHint(context: any): boolean {
  return Object.values(context.scope.findings).some((finding: any) => {
    const text = JSON.stringify(finding?.parsed ?? {}).toLowerCase();
    return text.includes("new york") || text.includes(" ny ") || text.includes("nyc");
  });
}

export default createAdapter({
  tool_name: "NY DOS",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "passive",
  async run(context) {
    if (!hasNyHint(context)) {
      return skippedRun("Disabled: no discovered company name/NY relevance hint");
    }
    return skippedRun("Adapter present; NY DOS connector requires explicit user-provided identifiers");
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
