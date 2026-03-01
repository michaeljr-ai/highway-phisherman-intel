import {
  createAdapter,
  getApiKey,
  hasApiKey,
  listPhones,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "Phone OSINT (Numverify/custom lookups)",
  inputs_required: ["derived_phone"],
  can_run_from: ["derived_phone"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const phones = listPhones(context);
    if (phones.length === 0) {
      return skippedRun("No discovered/provided phone numbers");
    }
    if (!hasApiKey(context, "numverify")) {
      return notConfiguredRun("Numverify API key missing");
    }

    const key = getApiKey(context, "numverify");
    const records = [];
    for (const phone of phones.slice(0, 10)) {
      const endpoint = `http://apilayer.net/api/validate?access_key=${encodeURIComponent(key)}&number=${encodeURIComponent(phone)}`;
      const data = await safeJsonFetch(context, endpoint);
      records.push({ phone, data });
    }

    return {
      status: "ok",
      endpoint: "http://apilayer.net/api/validate",
      raw: { records },
      summary: "Phone OSINT lookup completed"
    };
  },
  parse(raw) {
    const records = (raw as any)?.records ?? [];
    return {
      records: records.map((r: any) => ({
        phone: r.phone,
        valid: r.data?.valid,
        lineType: r.data?.line_type,
        carrier: r.data?.carrier,
        country: r.data?.country_name
      }))
    };
  }
});
