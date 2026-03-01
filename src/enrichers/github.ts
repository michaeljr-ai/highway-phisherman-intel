import {
  createAdapter,
  firstEmail,
  getApiKey,
  hasApiKey,
  listUsernames,
  safeJsonFetch,
  skippedRun
} from "./_factory.js";

export default createAdapter({
  tool_name: "GitHub API",
  inputs_required: ["derived_username"],
  can_run_from: ["email", "derived_username"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const usernames = listUsernames(context);
    const email = firstEmail(context);

    if (usernames.length === 0 && !email) {
      return skippedRun("No username/email in scope");
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json"
    };
    if (hasApiKey(context, "github")) {
      headers.Authorization = `Bearer ${getApiKey(context, "github")}`;
    }

    const queries = usernames.slice(0, 10);
    if (queries.length === 0 && email) {
      queries.push(email.split("@")[0]);
    }

    const results: Array<{ query: string; users: unknown }> = [];
    for (const query of queries) {
      const endpoint = `https://api.github.com/search/users?q=${encodeURIComponent(query)}+in:login`;
      const users = await safeJsonFetch(context, endpoint, { headers });
      results.push({ query, users });
    }

    return {
      status: "ok",
      endpoint: "https://api.github.com/search/users",
      raw: { results },
      summary: "GitHub username discovery completed"
    };
  },
  parse(raw) {
    const results = (raw as any)?.results ?? [];
    const items = results.flatMap((result: any) => result.users?.items ?? []);
    return {
      confirmedCount: items.length,
      profiles: items.slice(0, 50).map((item: any) => ({
        login: item.login,
        htmlUrl: item.html_url,
        type: item.type,
        score: item.score
      }))
    };
  }
});
