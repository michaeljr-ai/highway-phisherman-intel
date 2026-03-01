import {
  createAdapter,
  firstUrl,
  getApiKey,
  hasApiKey,
  notConfiguredRun,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

function extractRedirectChain(urlscanResult: any): string[] {
  const requests = urlscanResult?.lists?.requests ?? [];
  const chain: string[] = requests
    .map((req: any) => req?.request?.url)
    .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    .map(String);
  return Array.from(new Set<string>(chain)).slice(0, 40);
}

export default createAdapter({
  tool_name: "URLScan.io API",
  inputs_required: ["url"],
  can_run_from: ["url", "domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    if (!hasApiKey(context, "urlscan")) {
      return notConfiguredRun("URLScan API key missing");
    }

    const url = firstUrl(context);
    if (!url) {
      return skippedRun("No URL in scope");
    }

    const headers = {
      "API-Key": getApiKey(context, "urlscan"),
      "Content-Type": "application/json"
    };

    const submit = await safeJsonFetch(context, "https://urlscan.io/api/v1/scan/", {
      method: "POST",
      headers,
      body: JSON.stringify({ url, visibility: "private" })
    });

    const resultApi = (submit as any)?.api;
    let result: unknown = {};
    if (resultApi) {
      try {
        result = await safeJsonFetch(context, resultApi, { headers });
      } catch {
        result = { status: "pending" };
      }
    }

    return {
      status: "ok",
      endpoint: "https://urlscan.io/api/v1",
      raw: {
        submit,
        result
      },
      summary: "URLScan submission/search completed"
    };
  },
  parse(raw) {
    const result = (raw as any)?.result ?? {};
    const verdicts = result?.verdicts ?? {};
    const chain = extractRedirectChain(result);
    const credentialHarvestPattern =
      chain.some((url) => /login|signin|auth|verify|account|webscr/i.test(url)) &&
      (result?.stats?.malicious ?? 0) > 0;

    return {
      scanId: (raw as any)?.submit?.uuid,
      screenshot: (raw as any)?.submit?.screenshotURL,
      resultUrl: (raw as any)?.submit?.result,
      finalUrl: result?.page?.url,
      redirectChain: chain,
      requests: result?.stats?.requests ?? 0,
      malicious: verdicts?.overall?.malicious,
      categories: verdicts,
      credentialHarvestPattern
    };
  }
});
