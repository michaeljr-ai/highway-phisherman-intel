import { createAdapter, firstDomain, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Wayback Machine / Internet Archive API",
  inputs_required: ["domain"],
  can_run_from: ["domain", "url"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const domain = firstDomain(context);
    if (!domain) {
      return skippedRun("No domain in scope");
    }

    const endpoint = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}/*&output=json&fl=timestamp,original,statuscode,mimetype&filter=statuscode:200&limit=200`;
    const raw = await safeJsonFetch(context, endpoint);

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "Wayback snapshots collected"
    };
  },
  parse(raw) {
    const rows = Array.isArray(raw) ? raw : [];
    const headers = Array.isArray(rows[0]) ? (rows[0] as string[]) : [];
    const data = rows.slice(1).map((row: any[]) => {
      const item: Record<string, string> = {};
      headers.forEach((header, idx) => {
        item[header] = String(row[idx] ?? "");
      });
      return item;
    });

    const firstSeen = data[0]?.timestamp;
    const latestSeen = data[data.length - 1]?.timestamp;

    return {
      snapshotCount: data.length,
      firstSeen,
      latestSeen,
      snapshots: data.slice(0, 50)
    };
  }
});
