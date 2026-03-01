import { AppConfig } from "../../core/types.js";

export class PolyglotRiskGatewayClient {
  constructor(private readonly config: AppConfig) {}

  async assess(params: {
    target: string;
    evidence: string[];
    indicators: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null> {
    const baseUrl = this.config.fly.railsGatewayUrl;
    if (!baseUrl) {
      return null;
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/risk/assess`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(12_000)
    });

    if (!response.ok) {
      throw new Error(`Rails gateway risk request failed: ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}
