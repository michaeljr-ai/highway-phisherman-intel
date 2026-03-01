import { createAdapter, skippedRun } from "./_factory.js";

function hasIndiaHint(context: any): boolean {
  return Object.values(context.scope.findings).some((finding: any) => {
    const text = JSON.stringify(finding?.parsed ?? {}).toLowerCase();
    return text.includes(" india") || text.includes(".in") || text.includes("mumbai") || text.includes("delhi");
  });
}

export default createAdapter({
  tool_name: "India MCA / Zauba",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "passive",
  async run(context) {
    if (!hasIndiaHint(context)) {
      return skippedRun("Disabled: no discovered company name/India relevance hint");
    }
    return skippedRun("Adapter present; explicit registry integration for India corporate sources is required");
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
