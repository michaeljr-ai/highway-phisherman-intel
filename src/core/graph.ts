import { EntityEdge, EntityNode, GraphOutput } from "./types.js";

export function buildGraph(nodes: EntityNode[], edges: EntityEdge[]): GraphOutput {
  const dedupNodes = deduplicateNodes(nodes);
  const dedupEdges = deduplicateEdges(edges);

  const adjacency = new Map<string, Set<string>>();
  for (const node of dedupNodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of dedupEdges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const centrality: Record<string, number> = {};
  for (const node of dedupNodes) {
    const degree = adjacency.get(node.id)?.size ?? 0;
    centrality[node.id] = dedupNodes.length > 1 ? degree / (dedupNodes.length - 1) : 0;
  }

  const connectedComponents = countConnectedComponents(dedupNodes.map((n) => n.id), adjacency);

  return {
    nodes: dedupNodes,
    edges: dedupEdges,
    metrics: {
      nodeCount: dedupNodes.length,
      edgeCount: dedupEdges.length,
      connectedComponents,
      centrality
    }
  };
}

function deduplicateNodes(nodes: EntityNode[]): EntityNode[] {
  const map = new Map<string, EntityNode>();
  for (const node of nodes) {
    const existing = map.get(node.id);
    if (!existing) {
      map.set(node.id, node);
      continue;
    }
    map.set(node.id, {
      ...existing,
      tags: Array.from(new Set([...existing.tags, ...node.tags])),
      evidenceIds: Array.from(new Set([...existing.evidenceIds, ...node.evidenceIds])),
      properties: { ...existing.properties, ...node.properties }
    });
  }
  return Array.from(map.values());
}

function deduplicateEdges(edges: EntityEdge[]): EntityEdge[] {
  const map = new Map<string, EntityEdge>();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, edge);
      continue;
    }
    map.set(key, {
      ...existing,
      strength: Math.max(existing.strength, edge.strength),
      evidenceIds: Array.from(new Set([...existing.evidenceIds, ...edge.evidenceIds]))
    });
  }
  return Array.from(map.values());
}

function countConnectedComponents(nodes: string[], adjacency: Map<string, Set<string>>): number {
  const visited = new Set<string>();
  let components = 0;

  for (const node of nodes) {
    if (visited.has(node)) {
      continue;
    }
    components += 1;
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }

  return components;
}
