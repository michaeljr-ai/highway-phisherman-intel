import { createAdapter, skippedRun } from "./_factory.js";

function hasCanadaHint(context: any): boolean {
  return Object.values(context.scope.findings).some((finding: any) => {
    const text = JSON.stringify(finding?.parsed ?? {}).toLowerCase();
    return text.includes(" canada") || text.includes(".ca") || text.includes("ontario") || text.includes("quebec");
  });
}

export default createAdapter({
  tool_name: "Canada Corporations / Provincial Registries",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url", "email"],
  defaultEnabled: false,
  collectionMethod: "passive",
  async run(context) {
    if (!hasCanadaHint(context)) {
      return skippedRun("Disabled: no discovered company name/Canada relevance hint");
    }
    return skippedRun("Adapter present; explicit registry source connector not configured");
  },
  parse(raw) {
    return raw as Record<string, unknown>;
  }
});
