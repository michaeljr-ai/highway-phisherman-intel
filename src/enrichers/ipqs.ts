import {
  createAdapter,
  firstEmail,
  getApiKey,
  hasApiKey,
  listIps,
  listPhones,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "IPQualityScore (IPQS)",
  inputs_required: ["derived_ip"],
  can_run_from: ["derived_ip", "email", "derived_phone"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "ipqs")) {
      return notConfiguredRun("IPQS API key missing");
    }

    const key = getApiKey(context, "ipqs");
    const ips = listIps(context);
    const email = firstEmail(context);
    const phones = listPhones(context);

    if (ips.length === 0 && !email && phones.length === 0) {
      return skippedRun("No IP/email/phone in scope");
    }

    const ipResults = [];
    for (const ip of ips.slice(0, 20)) {
      const endpoint = `https://ipqualityscore.com/api/json/ip/${key}/${encodeURIComponent(ip)}`;
      const data = await safeJsonFetch(context, endpoint);
      ipResults.push({ ip, data });
    }

    const emailResult = email
      ? await safeJsonFetch(context, `https://ipqualityscore.com/api/json/email/${key}/${encodeURIComponent(email)}`)
      : null;

    const phoneResults = [];
    for (const phone of phones.slice(0, 5)) {
      const endpoint = `https://ipqualityscore.com/api/json/phone/${key}/${encodeURIComponent(phone)}`;
      const data = await safeJsonFetch(context, endpoint);
      phoneResults.push({ phone, data });
    }

    return {
      status: "ok",
      endpoint: "https://ipqualityscore.com/api/json",
      raw: {
        ipResults,
        emailResult,
        phoneResults
      },
      summary: "IPQS checks completed"
    };
  },
  parse(raw) {
    const ipResults = (raw as any)?.ipResults ?? [];
    const maxFraudScore = ipResults.reduce((max: number, record: any) => {
      return Math.max(max, Number(record.data?.fraud_score ?? 0));
    }, 0);

    return {
      maxFraudScore,
      ipSignals: ipResults.map((record: any) => ({
        ip: record.ip,
        fraudScore: record.data?.fraud_score,
        vpn: record.data?.vpn,
        proxy: record.data?.proxy,
        tor: record.data?.tor,
        botStatus: record.data?.bot_status
      })),
      emailSignal: (raw as any)?.emailResult,
      phoneSignals: (raw as any)?.phoneResults ?? []
    };
  }
});
