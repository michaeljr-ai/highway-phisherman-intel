import { ensureRuntimeInitialized, listJobs, runJob } from "./_lib/runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  try {
    await ensureRuntimeInitialized();
  } catch (error) {
    res.status(500).json({ error: "initialization_failed", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (req.method === "GET") {
    const jobs = await listJobs();
    res.status(200).json({ jobs });
    return;
  }

  if (req.method === "POST") {
    const target = typeof req.body?.target === "string" ? req.body.target : "";
    if (!target.trim()) {
      res.status(400).json({ error: "target is required (domain, URL, or email)" });
      return;
    }

    try {
      const job = await runJob({
        target,
        tlp: typeof req.body?.tlp === "string" ? req.body.tlp : undefined,
        activeRecon: req.body?.activeRecon === undefined ? undefined : Boolean(req.body.activeRecon)
      });
      res.status(job.status === "failed" ? 500 : 200).json({ job });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
      return;
    }
  }

  res.status(405).json({ error: "method_not_allowed" });
}
