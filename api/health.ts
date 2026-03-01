import { ensureRuntimeInitialized, runtimeHealth } from "./_lib/runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  try {
    await ensureRuntimeInitialized();
    res.status(200).json(runtimeHealth());
  } catch (error) {
    res.status(500).json({ error: "initialization_failed", message: error instanceof Error ? error.message : String(error) });
  }
}
