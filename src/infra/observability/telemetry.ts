import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { AppConfig } from "../../core/types.js";

let sdk: NodeSDK | undefined;

export async function startTelemetry(config: AppConfig): Promise<void> {
  if (!config.observability.otelEnabled) {
    return;
  }

  const exporter = new OTLPTraceExporter(
    config.observability.otlpEndpoint ? { url: config.observability.otlpEndpoint } : undefined
  );

  sdk = new NodeSDK({
    serviceName: config.observability.serviceName,
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  await Promise.resolve(sdk.start());
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await Promise.resolve(sdk.shutdown());
}

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer("highway-phisherman-app");
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.end();
      throw error;
    }
  });
}
