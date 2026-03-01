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
  tool_name: "Veriphone API",
  inputs_required: ["derived_phone"],
  can_run_from: ["derived_phone"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const phones = listPhones(context);
    if (phones.length === 0) {
      return skippedRun("No phone numbers discovered/provided");
    }
    if (!hasApiKey(context, "veriphone")) {
      return notConfiguredRun("Veriphone API key missing");
    }

    const key = getApiKey(context, "veriphone");
    const results = [];
    for (const phone of phones.slice(0, 10)) {
      const endpoint = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(phone)}&key=${encodeURIComponent(key)}`;
      const data = await safeJsonFetch(context, endpoint);
      results.push({ phone, data });
    }

    return {
      status: "ok",
      endpoint: "https://api.veriphone.io/v2/verify",
      raw: { results },
      summary: "Veriphone validation complete"
    };
  },
  parse(raw) {
    const results = (raw as any)?.results ?? [];
    return {
      phones: results.map((r: any) => ({
        phone: r.phone,
        valid: r.data?.phone_valid,
        carrier: r.data?.carrier,
        phoneType: r.data?.phone_type,
        country: r.data?.country
      }))
    };
  }
});
