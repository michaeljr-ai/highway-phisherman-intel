export type AllowedInputKind = "domain" | "url" | "email";
export type DerivedInputKind = "derived_ip" | "derived_username" | "derived_phone";
export type InputKind = AllowedInputKind | DerivedInputKind;

export type CollectionMethod = "passive" | "active" | "derived";

export type SeverityTag = "CRITICAL" | "ACTIVE" | "CONFIRMED" | "INFO";

export interface NormalizedInput {
  original: string;
  inputKind: AllowedInputKind;
  normalizedValue: string;
  observedUrl?: string;
  hostname?: string;
  rootDomain?: string;
  email?: {
    localPart: string;
    domain: string;
    canonical: string;
    gravatarMd5: string;
    derivedUsernames: string[];
  };
  flags: {
    isPunycode: boolean;
    possibleHomoglyph: boolean;
    suspiciousTld: boolean;
    isValid: boolean;
    validationError?: string;
  };
}

export interface EvidenceArtifact {
  artifactId: string;
  caseId: string;
  toolName: string;
  artifactType: "raw" | "parsed" | "error" | "image" | "xml" | "json" | "text";
  collectionMethod: CollectionMethod;
  createdAtUtc: string;
  endpoint?: string;
  toolVersion?: string;
  filePath: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export interface EnricherOutput {
  toolName: string;
  status: "ok" | "not_configured" | "disabled" | "skipped" | "error";
  statusReason?: string;
  summary: string;
  parsed: Record<string, unknown>;
  raw?: unknown;
  artifacts: EvidenceArtifact[];
  derived: {
    ips: string[];
    usernames: string[];
    phones: string[];
    emails: string[];
    domains: string[];
    urls: string[];
    certFingerprints: string[];
  };
}

export interface EnricherContext {
  caseId: string;
  nowUtc: string;
  activeReconEnabled: boolean;
  reconMode: "standard" | "aggressive";
  config: AppConfig;
  input: InvestigationInput;
  scope: ScopeState;
  utilities: {
    fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
    fetchText: (url: string, init?: RequestInit) => Promise<string>;
    runCommand: (cmd: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  };
}

export interface EnricherAdapter {
  tool_name: string;
  inputs_required: InputKind[];
  can_run_from: InputKind[];
  defaultEnabled: boolean;
  collectionMethod: CollectionMethod;
  run: (context: EnricherContext) => Promise<EnricherRunResult>;
  parse: (raw: unknown, context: EnricherContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface EnricherRunResult {
  endpoint?: string;
  toolVersion?: string;
  raw: unknown;
  status: EnricherOutput["status"];
  statusReason?: string;
  summary?: string;
}

export interface AuditEvent {
  tsUtc: string;
  eventType: string;
  wave: number;
  toolName?: string;
  status: "started" | "completed" | "failed" | "skipped";
  message: string;
  details: Record<string, unknown>;
}

export interface ScoreBreakdownItem {
  signalId: string;
  description: string;
  points: number;
  evidenceIds: string[];
}

export interface RiskScore {
  total: number;
  severity: "LOW" | "MED" | "HIGH" | "CRITICAL";
  confidencePct: number;
  breakdown: ScoreBreakdownItem[];
}

export interface EntityNode {
  id: string;
  type: "Domain" | "URL" | "IP" | "ASN" | "Cert" | "Email" | "Username" | "ToolFinding";
  label: string;
  tags: SeverityTag[];
  evidenceIds: string[];
  properties: Record<string, unknown>;
}

export interface EntityEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: number;
  evidenceIds: string[];
}

export interface GraphOutput {
  nodes: EntityNode[];
  edges: EntityEdge[];
  metrics: {
    nodeCount: number;
    edgeCount: number;
    connectedComponents: number;
    centrality: Record<string, number>;
  };
}

export interface ScopeState {
  domains: Set<string>;
  urls: Set<string>;
  emails: Set<string>;
  ips: Set<string>;
  usernames: Set<string>;
  phones: Set<string>;
  certFingerprints: Set<string>;
  findings: Record<string, EnricherOutput>;
}

export interface InvestigationInput {
  rawInputs: string[];
  normalizedInputs: NormalizedInput[];
  observedUrls: string[];
  primaryDomain?: string;
  primaryEmail?: string;
  caseId: string;
  tlp: string;
  startedAtUtc: string;
}

export interface AppConfig {
  outputRoot: string;
  defaultTlp: string;
  appEnv: "development" | "staging" | "production";
  pg: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean;
  };
  supabase: {
    url?: string;
    anonKey?: string;
    serviceRoleKey?: string;
    postgresUrl?: string;
  };
  neo4j: {
    uri?: string;
    username?: string;
    password?: string;
    database?: string;
  };
  cloudflare: {
    accountId?: string;
    apiToken?: string;
    workerBaseUrl?: string;
    r2Bucket?: string;
    queueIngressUrl?: string;
    queueIngressToken?: string;
    zeroTrustAudience?: string;
  };
  fly: {
    appName?: string;
    region?: string;
    riskEngineUrl?: string;
    railsGatewayUrl?: string;
  };
  eventing: {
    provider: "kafka" | "redpanda" | "cloudflare_queues" | "none";
    kafkaBrokers: string[];
    kafkaClientId: string;
    kafkaTopic: string;
    kafkaUsername?: string;
    kafkaPassword?: string;
    cloudflareQueueIngressUrl?: string;
    cloudflareQueueIngressToken?: string;
  };
  observability: {
    otelEnabled: boolean;
    otlpEndpoint?: string;
    serviceName: string;
    grafanaLokiEndpoint?: string;
    grafanaTempoEndpoint?: string;
  };
  security: {
    rbacEnabled: boolean;
    requireRoleKeys: boolean;
    zeroTrustRequired: boolean;
    privateMode: boolean;
    ownerAccessToken?: string;
    allowlistIps: string[];
    requestLimitPerMinute: number;
    sensitiveRequestLimitPerMinute: number;
    secretsProvider: "env" | "cloudflare" | "fly" | "hsm";
    roleKeys: Record<string, string>;
  };
  apiKeys: Record<string, string | undefined>;
  commandTimeoutMs: number;
}

export interface InvestigationResult {
  caseId: string;
  input: InvestigationInput;
  scope: ScopeState;
  enrichments: EnricherOutput[];
  graph: GraphOutput;
  score: RiskScore;
  keyLinkages: Array<{ text: string; evidenceIds: string[] }>;
  auditLog: AuditEvent[];
  evidence: EvidenceArtifact[];
  reportHtmlPath: string;
  evidenceJsonPath: string;
  auditJsonPath: string;
}

export interface MethodsReference {
  category: string;
  tools: string[];
}
