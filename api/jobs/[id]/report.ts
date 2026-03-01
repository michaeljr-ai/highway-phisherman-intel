import { ensureRuntimeInitialized, getJob } from "../../_lib/runtime.js";

function routeId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  try {
    await ensureRuntimeInitialized();
  } catch (error) {
    res.status(500).json({ error: "initialization_failed", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const id = routeId(req.query?.id);
  if (!id) {
    res.status(400).json({ error: "missing_job_id" });
    return;
  }

  const job = await getJob(id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "completed") {
    res.status(409).json({ error: "Report not ready" });
    return;
  }

  if (!job.reportHtml) {
    res.status(404).json({ error: "Report file missing" });
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(job.reportHtml);
}
