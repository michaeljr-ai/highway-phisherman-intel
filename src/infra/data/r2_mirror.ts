import { AppConfig } from "../../core/types.js";

export class R2Mirror {
  constructor(private readonly config: AppConfig) {}

  async mirrorBundle(params: { caseId: string; reportHtmlPath: string; evidenceJsonPath: string; auditJsonPath: string }): Promise<void> {
    const workerBaseUrl = this.config.cloudflare.workerBaseUrl;
    if (!workerBaseUrl || !this.config.cloudflare.apiToken) {
      return;
    }

    const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}/internal/r2-mirror`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.cloudflare.apiToken}`
      },
      body: JSON.stringify({
        bucket: this.config.cloudflare.r2Bucket,
        ...params
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`R2 mirror request failed: ${response.status}`);
    }
  }
}
