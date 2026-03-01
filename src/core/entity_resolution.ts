import { EnricherOutput, EntityEdge, EntityNode, InvestigationInput, ScopeState, SeverityTag } from "./types.js";

function tagForStatus(status: EnricherOutput["status"]): SeverityTag {
  switch (status) {
    case "error":
      return "CRITICAL";
    case "ok":
      return "CONFIRMED";
    case "disabled":
      return "INFO";
    case "not_configured":
      return "INFO";
    case "skipped":
      return "ACTIVE";
    default:
      return "INFO";
  }
}

function asNodeId(type: EntityNode["type"], value: string): string {
  return `${type.toLowerCase()}:${value.toLowerCase()}`;
}

export function resolveEntities(
  input: InvestigationInput,
  scope: ScopeState,
  findings: EnricherOutput[]
): { nodes: EntityNode[]; edges: EntityEdge[] } {
  const nodes: EntityNode[] = [];
  const edges: EntityEdge[] = [];

  const primaryDomain = input.primaryDomain;
  const primaryEmail = input.primaryEmail;

  for (const domain of scope.domains) {
    nodes.push({
      id: asNodeId("Domain", domain),
      type: "Domain",
      label: domain,
      tags: ["CONFIRMED"],
      evidenceIds: [],
      properties: { observed: domain === primaryDomain }
    });
  }

  for (const url of scope.urls) {
    nodes.push({
      id: asNodeId("URL", url),
      type: "URL",
      label: url,
      tags: ["CONFIRMED"],
      evidenceIds: [],
      properties: {}
    });
  }

  for (const ip of scope.ips) {
    nodes.push({
      id: asNodeId("IP", ip),
      type: "IP",
      label: ip,
      tags: ["ACTIVE"],
      evidenceIds: [],
      properties: {}
    });
  }

  for (const email of scope.emails) {
    nodes.push({
      id: asNodeId("Email", email),
      type: "Email",
      label: email,
      tags: [email === primaryEmail ? "CONFIRMED" : "ACTIVE"],
      evidenceIds: [],
      properties: { observed: email === primaryEmail }
    });
  }

  for (const username of scope.usernames) {
    nodes.push({
      id: asNodeId("Username", username),
      type: "Username",
      label: username,
      tags: ["ACTIVE"],
      evidenceIds: [],
      properties: {}
    });
  }

  for (const cert of scope.certFingerprints) {
    nodes.push({
      id: asNodeId("Cert", cert),
      type: "Cert",
      label: cert,
      tags: ["INFO"],
      evidenceIds: [],
      properties: {}
    });
  }

  const primaryDomainNode = primaryDomain ? asNodeId("Domain", primaryDomain) : undefined;

  for (const url of scope.urls) {
    if (primaryDomainNode && primaryDomain && url.includes(primaryDomain)) {
      edges.push({
        id: `edge-domain-url-${url}`,
        source: primaryDomainNode,
        target: asNodeId("URL", url),
        relation: "observed_url",
        strength: 0.9,
        evidenceIds: []
      });
    }
  }

  if (primaryDomain) {
    for (const ip of scope.ips) {
      edges.push({
        id: `edge-domain-ip-${ip}`,
        source: asNodeId("Domain", primaryDomain),
        target: asNodeId("IP", ip),
        relation: "resolves_to",
        strength: 0.7,
        evidenceIds: []
      });
    }
  }

  if (primaryEmail && primaryDomain) {
    edges.push({
      id: "edge-email-domain-primary",
      source: asNodeId("Email", primaryEmail),
      target: asNodeId("Domain", primaryDomain),
      relation: "email_domain",
      strength: 1,
      evidenceIds: []
    });
  }

  for (const finding of findings) {
    const findingNodeId = asNodeId("ToolFinding", finding.toolName);
    nodes.push({
      id: findingNodeId,
      type: "ToolFinding",
      label: finding.toolName,
      tags: [tagForStatus(finding.status)],
      evidenceIds: finding.artifacts.map((a) => a.artifactId),
      properties: {
        status: finding.status,
        summary: finding.summary
      }
    });

    for (const domain of finding.derived.domains) {
      edges.push({
        id: `${findingNodeId}-domain-${domain}`,
        source: findingNodeId,
        target: asNodeId("Domain", domain),
        relation: "mentions_domain",
        strength: 0.5,
        evidenceIds: finding.artifacts.map((a) => a.artifactId)
      });
    }
    for (const ip of finding.derived.ips) {
      edges.push({
        id: `${findingNodeId}-ip-${ip}`,
        source: findingNodeId,
        target: asNodeId("IP", ip),
        relation: "mentions_ip",
        strength: 0.55,
        evidenceIds: finding.artifacts.map((a) => a.artifactId)
      });
    }
    for (const cert of finding.derived.certFingerprints) {
      edges.push({
        id: `${findingNodeId}-cert-${cert}`,
        source: findingNodeId,
        target: asNodeId("Cert", cert),
        relation: "mentions_cert",
        strength: 0.65,
        evidenceIds: finding.artifacts.map((a) => a.artifactId)
      });
    }
    for (const username of finding.derived.usernames) {
      edges.push({
        id: `${findingNodeId}-username-${username}`,
        source: findingNodeId,
        target: asNodeId("Username", username),
        relation: "mentions_username",
        strength: 0.6,
        evidenceIds: finding.artifacts.map((a) => a.artifactId)
      });
    }
    for (const email of finding.derived.emails) {
      edges.push({
        id: `${findingNodeId}-email-${email}`,
        source: findingNodeId,
        target: asNodeId("Email", email),
        relation: "mentions_email",
        strength: 0.6,
        evidenceIds: finding.artifacts.map((a) => a.artifactId)
      });
    }
  }

  return { nodes, edges };
}
