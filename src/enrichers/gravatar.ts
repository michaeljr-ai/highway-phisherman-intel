import crypto from "node:crypto";
import { createAdapter, firstEmail, safeJsonFetch, skippedRun } from "./_factory.js";

export default createAdapter({
  tool_name: "Gravatar API",
  inputs_required: ["email"],
  can_run_from: ["email"],
  defaultEnabled: true,
  collectionMethod: "passive",
  async run(context) {
    const email = firstEmail(context);
    if (!email) {
      return skippedRun("No email in scope");
    }

    const hash = crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
    const endpoint = `https://www.gravatar.com/${hash}.json`;

    const raw = await safeJsonFetch(context, endpoint);

    return {
      status: "ok",
      endpoint,
      raw: {
        hash,
        profile: raw
      },
      summary: "Gravatar profile lookup complete"
    };
  },
  parse(raw) {
    const profile = (raw as any)?.profile;
    const entry = Array.isArray(profile?.entry) ? profile.entry[0] : undefined;

    return {
      hash: (raw as any)?.hash,
      displayName: entry?.displayName,
      profileUrl: entry?.profileUrl,
      thumbnailUrl: entry?.thumbnailUrl,
      photos: entry?.photos ?? [],
      accounts: entry?.accounts ?? []
    };
  }
});
