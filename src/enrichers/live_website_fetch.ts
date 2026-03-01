import { createAdapter, firstUrl, skippedRun } from "./_factory.js";

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim();
}

export default createAdapter({
  tool_name: "Live Website Fetching (curl/wget safe mode)",
  inputs_required: ["url"],
  can_run_from: ["url", "domain"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    let url = firstUrl(context);
    if (!url && context.input.primaryDomain) {
      url = `https://${context.input.primaryDomain}`;
    }
    if (!url) {
      return skippedRun("No URL in scope");
    }

    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "User-Agent": "highway-phisherman/1.0"
      }
    });

    const body = await response.text();
    const sample = body.slice(0, 2500);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: "ok",
      endpoint: url,
      raw: {
        url,
        status: response.status,
        finalUrl: response.url,
        headers,
        sample
      },
      summary: `Fetched ${url} with status ${response.status}`
    };
  },
  parse(raw) {
    const sample = String((raw as any)?.sample ?? "");
    const title = extractTitle(sample);
    return {
      status: (raw as any)?.status,
      finalUrl: (raw as any)?.finalUrl,
      title,
      headers: (raw as any)?.headers ?? {},
      sample,
      hasLoginKeywords: /login|signin|verify|password|account/i.test(sample)
    };
  }
});
