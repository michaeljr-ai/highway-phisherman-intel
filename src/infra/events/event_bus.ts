import { Kafka, SASLOptions } from "kafkajs";
import { AppConfig } from "../../core/types.js";

export interface EventEnvelope {
  type: string;
  tsUtc: string;
  jobId?: string;
  caseId?: string;
  payload: Record<string, unknown>;
}

export interface EventBus {
  publish(event: EventEnvelope): Promise<void>;
  shutdown(): Promise<void>;
}

class NoopEventBus implements EventBus {
  async publish(_event: EventEnvelope): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

class KafkaEventBus implements EventBus {
  private readonly topic: string;
  private readonly producer;
  private connected = false;

  constructor(config: AppConfig) {
    const sasl: SASLOptions | undefined =
      config.eventing.kafkaUsername && config.eventing.kafkaPassword
        ? {
            mechanism: "plain",
            username: config.eventing.kafkaUsername,
            password: config.eventing.kafkaPassword
          }
        : undefined;

    const kafka = new Kafka({
      clientId: config.eventing.kafkaClientId,
      brokers: config.eventing.kafkaBrokers,
      ssl: true,
      sasl
    });

    this.producer = kafka.producer();
    this.topic = config.eventing.kafkaTopic;
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: event.jobId ?? event.caseId ?? event.type,
          value: JSON.stringify(event)
        }
      ]
    });
  }

  async shutdown(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }
}

class CloudflareQueueIngressBus implements EventBus {
  constructor(private readonly ingressUrl: string, private readonly token?: string) {}

  async publish(event: EventEnvelope): Promise<void> {
    const response = await fetch(this.ingressUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        queue: "intel-job-events",
        event
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`Cloudflare queue ingress failed: ${response.status}`);
    }
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

export function createEventBus(config: AppConfig): EventBus {
  if (config.eventing.provider === "kafka" || config.eventing.provider === "redpanda") {
    if (config.eventing.kafkaBrokers.length === 0) {
      return new NoopEventBus();
    }
    return new KafkaEventBus(config);
  }

  if (config.eventing.provider === "cloudflare_queues") {
    const ingress = config.eventing.cloudflareQueueIngressUrl ?? config.cloudflare.queueIngressUrl;
    if (!ingress) {
      return new NoopEventBus();
    }
    return new CloudflareQueueIngressBus(ingress, config.eventing.cloudflareQueueIngressToken);
  }

  return new NoopEventBus();
}
