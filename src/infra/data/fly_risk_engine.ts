import { AppConfig } from "../../core/types.js";

export interface RiskEngineRequest {
  caseId: string;
  target: string;
  enrichments: number;
}

export class FlyRiskEngineClient {
  constructor(private readonly config: AppConfig) {}

  async evaluate(payload: RiskEngineRequest): Promise<Record<string, unknown> | null> {
    const baseUrl = this.config.fly.riskEngineUrl;
    if (!baseUrl) {
      return null;
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000)
    });

    if (!response.ok) {
      throw new Error(`Fly risk engine request failed: ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}
