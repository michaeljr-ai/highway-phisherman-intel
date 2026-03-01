import { createAdapter, firstEmail, listUsernames, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "StopForumSpam API",
  inputs_required: ["email"],
  can_run_from: ["email", "derived_username", "derived_ip"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const email = firstEmail(context);
    const username = listUsernames(context)[0];

    if (!email && !username) {
      return skippedRun("No email/username in scope");
    }

    const params = new URLSearchParams({
      json: "1"
    });
    if (email) params.set("email", email);
    if (username) params.set("username", username);

    const endpoint = `https://api.stopforumspam.org/api?${params.toString()}`;
    const raw = await safeJsonFetch(context, endpoint);

    return {
      status: "ok",
      endpoint,
      raw,
      summary: "StopForumSpam lookup complete"
    };
  },
  parse(raw) {
    const emailAppears = Boolean((raw as any)?.email?.appears);
    const usernameAppears = Boolean((raw as any)?.username?.appears);

    return {
      hit: emailAppears || usernameAppears,
      email: (raw as any)?.email,
      username: (raw as any)?.username
    };
  }
});
