import { buildGraph } from "./graph.js";
import { resolveEntities } from "./entity_resolution.js";
import { EnricherOutput, GraphOutput, InvestigationInput, ScopeState } from "./types.js";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function fuseFindings(
  input: InvestigationInput,
  scope: ScopeState,
  findings: EnricherOutput[]
): {
  graph: GraphOutput;
  keyLinkages: Array<{ text: string; evidenceIds: string[] }>;
} {
  const { nodes, edges } = resolveEntities(input, scope, findings);

  const keyLinkages: Array<{ text: string; evidenceIds: string[] }> = [];

  const certLinks = findings
    .filter((f) => f.derived.certFingerprints.length > 0)
    .flatMap((f) =>
      f.derived.certFingerprints.map((cert) => ({
        cert,
        tool: f.toolName,
        evidence: f.artifacts.map((a) => a.artifactId)
      }))
    );

  for (const cert of unique(certLinks.map((c) => c.cert))) {
    const linked = certLinks.filter((c) => c.cert === cert);
    if (linked.length > 1) {
      keyLinkages.push({
        text: `Shared certificate fingerprint ${cert} observed by ${linked.map((x) => x.tool).join(", ")}`,
        evidenceIds: unique(linked.flatMap((x) => x.evidence))
      });
    }
  }

  const ipLinks = findings
    .filter((f) => f.derived.ips.length > 0)
    .flatMap((f) =>
      f.derived.ips.map((ip) => ({
        ip,
        tool: f.toolName,
        evidence: f.artifacts.map((a) => a.artifactId)
      }))
    );

  for (const ip of unique(ipLinks.map((i) => i.ip))) {
    const linked = ipLinks.filter((i) => i.ip === ip);
    if (linked.length > 1) {
      keyLinkages.push({
        text: `Shared IP ${ip} correlates across ${linked.map((x) => x.tool).join(", ")}`,
        evidenceIds: unique(linked.flatMap((x) => x.evidence))
      });
    }
  }

  const usernameLinks = findings
    .filter((f) => f.derived.usernames.length > 0)
    .flatMap((f) =>
      f.derived.usernames.map((username) => ({
        username,
        tool: f.toolName,
        evidence: f.artifacts.map((a) => a.artifactId)
      }))
    );

  for (const username of unique(usernameLinks.map((u) => u.username))) {
    const linked = usernameLinks.filter((u) => u.username === username);
    if (linked.length > 1) {
      keyLinkages.push({
        text: `Username ${username} appears across multiple identity tools (${linked
          .map((x) => x.tool)
          .join(", ")})`,
        evidenceIds: unique(linked.flatMap((x) => x.evidence))
      });
    }
  }

  const graph = buildGraph(nodes, edges);

  return {
    graph,
    keyLinkages
  };
}
