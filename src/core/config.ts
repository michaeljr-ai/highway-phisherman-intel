import path from "node:path";
import { AppConfig } from "./types.js";

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.entries(parsed).reduce<Record<string, string>>((acc, [k, v]) => {
      if (typeof v === "string") {
        acc[k] = v;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRoleKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = parseJsonMap(env.RBAC_ROLE_KEYS_JSON);

  const viewer = env.RBAC_VIEWER_KEY?.trim();
  const analyst = env.RBAC_ANALYST_KEY?.trim();
  const admin = env.RBAC_ADMIN_KEY?.trim();

  if (viewer) keys.viewer = viewer;
  if (analyst) keys.analyst = analyst;
  if (admin) keys.admin = admin;

  return keys;
}

export function loadConfig(): AppConfig {
  const isVercelRuntime = process.env.VERCEL === "1";
  const outputRoot = process.env.OUTPUT_ROOT ?? (isVercelRuntime ? "/tmp/briefings" : "./output/briefings");
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  const normalizedEnv: AppConfig["appEnv"] =
    appEnv === "production" || appEnv === "staging" ? (appEnv as AppConfig["appEnv"]) : "development";
  const eventProviderRaw = (process.env.EVENT_PROVIDER ?? "none").toLowerCase();
  const eventProvider: AppConfig["eventing"]["provider"] =
    eventProviderRaw === "kafka" ||
    eventProviderRaw === "redpanda" ||
    eventProviderRaw === "cloudflare_queues"
      ? (eventProviderRaw as AppConfig["eventing"]["provider"])
      : "none";

  return {
    outputRoot: path.resolve(outputRoot),
    defaultTlp: process.env.DEFAULT_TLP ?? "TLP:RED",
    appEnv: normalizedEnv,
    pg: {
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: boolFromEnv(process.env.PGSSL, false)
    },
    supabase: {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      postgresUrl: process.env.SUPABASE_POSTGRES_URL
    },
    neo4j: {
      uri: process.env.NEO4J_URI,
      username: process.env.NEO4J_USERNAME,
      password: process.env.NEO4J_PASSWORD,
      database: process.env.NEO4J_DATABASE
    },
    cloudflare: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      workerBaseUrl: process.env.CLOUDFLARE_WORKER_BASE_URL,
      r2Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      queueIngressUrl: process.env.CLOUDFLARE_QUEUE_INGRESS_URL,
      queueIngressToken: process.env.CLOUDFLARE_QUEUE_INGRESS_TOKEN,
      zeroTrustAudience: process.env.CLOUDFLARE_ZERO_TRUST_AUD
    },
    fly: {
      appName: process.env.FLY_APP_NAME,
      region: process.env.FLY_REGION,
      riskEngineUrl: process.env.FLY_RISK_ENGINE_URL,
      railsGatewayUrl: process.env.RAILS_GATEWAY_URL
    },
    eventing: {
      provider: eventProvider,
      kafkaBrokers: parseCsv(process.env.KAFKA_BROKERS),
      kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "highway-phisherman-app",
      kafkaTopic: process.env.KAFKA_TOPIC ?? "intel.jobs.events",
      kafkaUsername: process.env.KAFKA_USERNAME,
      kafkaPassword: process.env.KAFKA_PASSWORD,
      cloudflareQueueIngressUrl: process.env.CLOUDFLARE_QUEUE_INGRESS_URL,
      cloudflareQueueIngressToken: process.env.CLOUDFLARE_QUEUE_INGRESS_TOKEN
    },
    observability: {
      otelEnabled: boolFromEnv(process.env.OTEL_ENABLED, true),
      otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: process.env.OTEL_SERVICE_NAME ?? "highway-phisherman-app",
      grafanaLokiEndpoint: process.env.GRAFANA_LOKI_ENDPOINT,
      grafanaTempoEndpoint: process.env.GRAFANA_TEMPO_ENDPOINT
    },
    security: {
      rbacEnabled: boolFromEnv(process.env.RBAC_ENABLED, true),
      requireRoleKeys: boolFromEnv(process.env.RBAC_REQUIRE_KEYS, true),
      zeroTrustRequired: boolFromEnv(process.env.ZERO_TRUST_REQUIRED, false),
      privateMode: boolFromEnv(process.env.PRIVATE_MODE, false),
      ownerAccessToken: process.env.OWNER_ACCESS_TOKEN,
      allowlistIps: parseCsv(process.env.ALLOWLIST_IPS),
      requestLimitPerMinute: process.env.REQUEST_LIMIT_PER_MINUTE
        ? Number(process.env.REQUEST_LIMIT_PER_MINUTE)
        : 120,
      sensitiveRequestLimitPerMinute: process.env.SENSITIVE_REQUEST_LIMIT_PER_MINUTE
        ? Number(process.env.SENSITIVE_REQUEST_LIMIT_PER_MINUTE)
        : 30,
      secretsProvider: (process.env.SECRETS_PROVIDER?.toLowerCase() as AppConfig["security"]["secretsProvider"]) ?? "env",
      roleKeys: parseRoleKeys(process.env)
    },
    apiKeys: {
      shodan: process.env.SHODAN_API_KEY,
      virustotal: process.env.VIRUSTOTAL_API_KEY,
      hunter: process.env.HUNTER_API_KEY,
      abuseipdb: process.env.ABUSEIPDB_API_KEY,
      scamalytics: process.env.SCAMALYTICS_API_KEY,
      ipqs: process.env.IPQS_API_KEY,
      veriphone: process.env.VERIPHONE_API_KEY,
      greip: process.env.GREIP_API_KEY,
      ipstack: process.env.IPSTACK_API_KEY,
      ipgeolocation: process.env.IPGEOLOCATION_API_KEY,
      censysId: process.env.CENSYS_API_ID,
      censysSecret: process.env.CENSYS_API_SECRET,
      urlscan: process.env.URLSCAN_API_KEY,
      hostio: process.env.HOSTIO_API_KEY,
      stopforumspam: process.env.STOPFORUMSPAM_API_KEY,
      github: process.env.GITHUB_TOKEN,
      numverify: process.env.NUMVERIFY_API_KEY,
      maxmind: process.env.MAXMIND_LICENSE_KEY
    },
    commandTimeoutMs: process.env.COMMAND_TIMEOUT_MS ? Number(process.env.COMMAND_TIMEOUT_MS) : 60_000
  };
}

export function isPgConfigured(config: AppConfig): boolean {
  if (config.supabase.postgresUrl) {
    return true;
  }
  return Boolean(config.pg.host && config.pg.user && config.pg.database);
}
